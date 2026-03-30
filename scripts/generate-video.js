#!/usr/bin/env node
/**
 * PaceStore — Générateur de vidéo TikTok 30s
 * Workflow : Script (Claude) → Voix off (ElevenLabs) → Montage (FFmpeg)
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const https = require("https");
const { execSync } = require("child_process");
const Anthropic = require("@anthropic-ai/sdk");

// ─── Chemins ────────────────────────────────────────────────────────────────
const ROOT = path.join(__dirname, "..");
const OUTPUT_DIR = path.join(ROOT, "output");
const ASSETS_DIR = path.join(ROOT, "public", "assets", "generated");
const SCRIPT_PATH = path.join(OUTPUT_DIR, "script.txt");
const AUDIO_PATH = path.join(OUTPUT_DIR, "voiceover.mp3");
const SRT_PATH = path.join(OUTPUT_DIR, "subtitles.srt");
const CONCAT_PATH = path.join(OUTPUT_DIR, "images.txt");
const FILTER_SCRIPT_PATH = path.join(OUTPUT_DIR, "filter.txt");
const VIDEO_PATH = path.join(ROOT, "video-tiktok.mp4");
const BG_MUSIC_PATH = path.join(ROOT, "public", "assets", "background-music.mp3");

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.mkdirSync(ASSETS_DIR, { recursive: true });

// ─── Helpers ─────────────────────────────────────────────────────────────────
function log(emoji, msg) {
  console.log(`${emoji}  ${msg}`);
}

function checkFFmpeg() {
  try {
    execSync("ffmpeg -version", { stdio: "pipe" });
  } catch {
    throw new Error("FFmpeg non trouvé. Installe-le : brew install ffmpeg");
  }
}

function hasSubtitlesFilter() {
  try {
    const out = execSync("ffmpeg -filters 2>&1", { encoding: "utf8" });
    return out.includes(" subtitles ");
  } catch {
    return false;
  }
}

/** Formatte secondes → HH:MM:SS,mmm pour SRT */
function toSrtTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

// ─── ÉTAPE 1 : Génération du script via Claude ───────────────────────────────
async function generateScript() {
  log("✍️", "Génération du script TikTok via Claude…");

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY manquante dans .env");
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 600,
    system: `Tu es un expert copywriter TikTok pour PaceStore, boutique e-commerce running premium.
Identité visuelle : noir #0A0A0A, orange #FF5C00. Ton : expert running, direct, énergique.
Tu écris UNIQUEMENT le texte à lire à voix haute — pas de tirets, pas de didascalies, pas de balises.
Durée cible : 28-32 secondes (≈ 80-95 mots en français parlé naturel).`,
    messages: [
      {
        role: "user",
        content: `Écris un script vidéo TikTok 30 secondes optimisé conversion pour PaceStore.

Structure obligatoire :
1. HOOK (3 premières secondes) — phrase choc qui arrête le scroll
2. PROBLÈME — douleur du runner amateur / intermédiaire
3. SOLUTION — ce que PaceStore apporte (sélection premium, expertise, qualité)
4. CTA — appel à l'action direct (lien en bio, swipe up, etc.)

Écris uniquement le texte parlé, fluide et naturel, prêt pour la voix off.`,
      },
    ],
  });

  const script = response.content[0].text.trim();
  fs.writeFileSync(SCRIPT_PATH, script, "utf8");
  log("✅", `Script généré (${script.split(/\s+/).length} mots)`);
  console.log("\n─────────────────────────────────────\n" + script + "\n─────────────────────────────────────\n");
  return script;
}

// ─── ÉTAPE 2 : Voix off via ElevenLabs ───────────────────────────────────────
async function findVoiceId(apiKey, voiceName) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.elevenlabs.io",
      path: "/v1/voices",
      method: "GET",
      headers: { "xi-api-key": apiKey },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`ElevenLabs voices API: ${res.statusCode} ${data}`));
        }
        const { voices } = JSON.parse(data);
        const name = voiceName.toLowerCase();
        const match = voices.find(
          (v) => v.name.toLowerCase().includes(name) || v.name.toLowerCase().startsWith(name)
        );
        if (!match) {
          console.log("Voix disponibles :", voices.map((v) => v.name).join(", "));
          return reject(new Error(`Voix "${voiceName}" introuvable dans ElevenLabs.`));
        }
        resolve(match.voice_id);
      });
    });

    req.on("error", reject);
    req.end();
  });
}

async function generateVoiceover(script) {
  log("🎙️", "Génération de la voix off via ElevenLabs…");

  if (!process.env.ELEVENLABS_API_KEY) {
    throw new Error("ELEVENLABS_API_KEY manquante dans .env");
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = await findVoiceId(apiKey, "Liam");
  log("🔊", `Voix trouvée : ID ${voiceId}`);

  const body = JSON.stringify({
    text: script,
    model_id: "eleven_multilingual_v2",
    voice_settings: {
      stability: 0.45,
      similarity_boost: 0.82,
      style: 0.35,
      use_speaker_boost: true,
    },
  });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.elevenlabs.io",
      path: `/v1/text-to-speech/${voiceId}`,
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      if (res.statusCode !== 200) {
        let err = "";
        res.on("data", (c) => (err += c));
        res.on("end", () => reject(new Error(`ElevenLabs TTS ${res.statusCode}: ${err}`)));
        return;
      }
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const audio = Buffer.concat(chunks);
        fs.writeFileSync(AUDIO_PATH, audio);
        log("✅", `Voix off sauvegardée → ${AUDIO_PATH}`);
        resolve();
      });
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ─── ÉTAPE 3 : Génération des sous-titres SRT ────────────────────────────────
function getAudioDuration() {
  try {
    const out = execSync(
      `ffprobe -v error -show_entries format=duration -of csv=p=0 "${AUDIO_PATH}"`,
      { encoding: "utf8" }
    ).trim();
    return parseFloat(out) || 30;
  } catch {
    return 30;
  }
}

function generateSubtitles(script) {
  log("📝", "Génération des sous-titres SRT…");

  const duration = getAudioDuration();
  const words = script.split(/\s+/).filter(Boolean);
  const wordsPerSub = 6; // ~6 mots par sous-titre
  const chunks = [];

  for (let i = 0; i < words.length; i += wordsPerSub) {
    chunks.push(words.slice(i, i + wordsPerSub).join(" "));
  }

  const secPerChunk = duration / chunks.length;
  let srt = "";

  chunks.forEach((text, idx) => {
    const start = idx * secPerChunk;
    const end = Math.min((idx + 1) * secPerChunk, duration);
    srt += `${idx + 1}\n${toSrtTime(start)} --> ${toSrtTime(end)}\n${text}\n\n`;
  });

  fs.writeFileSync(SRT_PATH, srt, "utf8");
  log("✅", `${chunks.length} sous-titres générés → ${SRT_PATH}`);
}

// ─── ÉTAPE 4 : Montage FFmpeg ─────────────────────────────────────────────────
function buildImageConcat() {
  const extensions = [".jpg", ".jpeg", ".png", ".webp"];
  const images = fs
    .readdirSync(ASSETS_DIR)
    .filter((f) => extensions.includes(path.extname(f).toLowerCase()))
    .sort()
    .map((f) => path.join(ASSETS_DIR, f));

  if (images.length === 0) {
    log("⚠️", "Aucune image dans public/assets/generated/ — création d'un fond noir");
    // Crée une image placeholder noire 1080×1920
    const placeholder = path.join(OUTPUT_DIR, "placeholder.png");
    execSync(
      `ffmpeg -y -f lavfi -i color=c=black:s=1080x1920:r=1 -frames:v 1 "${placeholder}"`,
      { stdio: "pipe" }
    );
    images.push(placeholder);
  }

  const duration = getAudioDuration();
  const durationPerImage = duration / images.length;

  const lines = images
    .map((img) => `file '${img.replace(/'/g, "\\'")}'\nduration ${durationPerImage.toFixed(3)}`)
    .join("\n");
  // Répète la dernière image pour éviter le bug de durée FFmpeg concat
  lines.concat(`\nfile '${images[images.length - 1].replace(/'/g, "\\'")}'\n`);

  const content =
    lines + `\nfile '${images[images.length - 1].replace(/'/g, "\\'")}'\n`;
  fs.writeFileSync(CONCAT_PATH, content, "utf8");
  log("🖼️", `${images.length} image(s) préparées pour le slideshow`);
  return images.length;
}

async function assembleVideo() {
  log("🎬", "Assemblage de la vidéo avec FFmpeg…");
  checkFFmpeg();

  buildImageConcat();

  const hasBgMusic = fs.existsSync(BG_MUSIC_PATH);
  if (!hasBgMusic) {
    log("🎵", "Pas de musique de fond trouvée → vidéo sans fond musical");
  }

  const canBurnSubs = hasSubtitlesFilter();
  if (!canBurnSubs) {
    log("⚠️", "Filtre 'subtitles' absent (FFmpeg sans libass) → sous-titres non incrustés");
    log("💡", "Pour activer : brew install libass && brew reinstall ffmpeg --build-from-source");
  }

  // Normalise le chemin SRT pour FFmpeg
  const srtEscaped = SRT_PATH.replace(/\\/g, "/");

  let filterComplex, audioMap;

  // Sous-filtre vidéo : avec ou sans sous-titres selon la dispo de libass
  const videoScale =
    `[0:v]scale=1080:1920:force_original_aspect_ratio=decrease,` +
    `pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30[vscaled]`;

  // Style sous-titres : virgules échappées (séparateurs FFmpeg de second niveau)
  const subStyleEscaped =
    "FontName=Arial\\,FontSize=22\\,Bold=1\\,PrimaryColour=&H00FFFFFF\\," +
    "OutlineColour=&H00000000\\,Outline=2\\,Shadow=1\\," +
    "Alignment=2\\,MarginV=60";

  const videoFilter = canBurnSubs
    ? `${videoScale};\n[vscaled]subtitles=${srtEscaped}:force_style=${subStyleEscaped}[vout]`
    : `${videoScale};\n[vscaled]copy[vout]`;

  if (hasBgMusic) {
    filterComplex = [
      videoFilter + ";",
      // Audio : voix off plein volume + musique 20%
      `[1:a]volume=1.0[vo];`,
      `[2:a]volume=0.2,aloop=loop=-1:size=2e+09[bg];`,
      `[vo][bg]amix=inputs=2:duration=first:dropout_transition=2[aout]`,
    ].join("\n");
    audioMap = "[aout]";
  } else {
    filterComplex = videoFilter;
    audioMap = "1:a";
  }

  const inputs = [
    `-f concat -safe 0 -i "${CONCAT_PATH}"`,
    `-i "${AUDIO_PATH}"`,
    hasBgMusic ? `-i "${BG_MUSIC_PATH}"` : "",
  ]
    .filter(Boolean)
    .join(" ");

  fs.writeFileSync(FILTER_SCRIPT_PATH, filterComplex, "utf8");

  const cmd = [
    `ffmpeg -y`,
    inputs,
    `-filter_complex_script "${FILTER_SCRIPT_PATH}"`,
    `-map "[vout]"`,
    `-map "${audioMap}"`,
    `-c:v libx264 -preset fast -crf 23`,
    `-c:a aac -b:a 192k`,
    `-movflags +faststart`,
    `-shortest`,
    `"${VIDEO_PATH}"`,
  ].join(" \\\n  ");

  log("⚙️", "Commande FFmpeg :\n" + cmd + "\n");

  try {
    execSync(cmd, { stdio: "inherit" });
  } catch (e) {
    throw new Error("FFmpeg a échoué. Voir les logs ci-dessus.");
  }

  const stats = fs.statSync(VIDEO_PATH);
  const mb = (stats.size / 1024 / 1024).toFixed(1);
  log("✅", `Vidéo générée → ${VIDEO_PATH} (${mb} MB)`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("\n🏃 PaceStore — Générateur de vidéo TikTok\n");

  try {
    const script = await generateScript();
    await generateVoiceover(script);
    generateSubtitles(script);
    await assembleVideo();

    console.log("\n🎉 Workflow terminé !");
    console.log(`   📄 Script   : ${SCRIPT_PATH}`);
    console.log(`   🎙️  Audio    : ${AUDIO_PATH}`);
    console.log(`   📝 Subs     : ${SRT_PATH}`);
    console.log(`   🎬 Vidéo    : ${VIDEO_PATH}`);
  } catch (err) {
    console.error("\n❌ Erreur :", err.message);
    process.exit(1);
  }
}

main();
