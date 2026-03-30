#!/usr/bin/env node
/**
 * PaceStore — CEO Agent IA
 * Chef de projet qui analyse les instructions, produit un plan structuré,
 * attend la validation de Mounir, puis orchestre l'exécution par agent.
 */

require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs");
const path = require("path");

// ─── Config ───────────────────────────────────────────────────────────────────
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const AUTHORIZED_USER = process.env.TELEGRAM_USER_ID;
const PROJECT_PATH = process.env.PROJECT_PATH || "../pacestore";
const ROOT = __dirname;
const CAMPAIGNS_PATH = path.join(ROOT, "campaigns.json");

// ─── État en mémoire par chat ─────────────────────────────────────────────────
// chatId → { plan, instruction, waitingForFeedback }
const pendingPlans = {};

// ─── Agents disponibles ───────────────────────────────────────────────────────
const AGENTS = {
  Copywriter: {
    emoji: "🖊️",
    description: "Rédaction, scripts ads, landing pages, emails, storytelling",
    systemPrompt: (products) =>
      `Tu es le Copywriter senior de PaceStore, boutique e-commerce running premium.
Identité visuelle : noir #0A0A0A, orange #FF5C00. Ton : expert running, direct, énergique.
Catalogue produits disponible : ${JSON.stringify(products)}
Produis du contenu percutant, orienté conversion, en français.`,
  },
  Designer: {
    emoji: "🎨",
    description: "Briefs créatifs, guidelines visuelles, specs assets",
    systemPrompt: () =>
      `Tu es le Directeur Artistique de PaceStore, boutique e-commerce running premium.
Identité : noir #0A0A0A, orange #FF5C00, typographie moderne et sportive.
Produis des briefs créatifs ultra-détaillés : dimensions, couleurs (hex), typo, composition,
hiérarchie visuelle, références visuelles, ambiance. En français, format professionnel.`,
  },
  Dev: {
    emoji: "💻",
    description: "Modifications site, intégrations, automatisations techniques",
    systemPrompt: () =>
      `Tu es le Lead Developer de PaceStore (e-commerce running premium).
Stack : Next.js, React, e-commerce headless. Produis des spécifications techniques précises,
du code si nécessaire, des étapes d'implémentation claires. En français.`,
  },
  Ads: {
    emoji: "📣",
    description: "Stratégie média, budgets, ciblages Meta/TikTok/Google",
    systemPrompt: (products) =>
      `Tu es le Media Buyer / Ads Manager de PaceStore (running premium).
Produis des stratégies média complètes : choix des plateformes, ciblages précis,
budgets recommandés, formats d'annonces, copies, calendrier de diffusion.
Catalogue : ${JSON.stringify(products)}. En français.`,
  },
};

// ─── Mémoire des campagnes ────────────────────────────────────────────────────
function loadCampaigns() {
  try {
    if (fs.existsSync(CAMPAIGNS_PATH)) {
      return JSON.parse(fs.readFileSync(CAMPAIGNS_PATH, "utf8"));
    }
  } catch {}
  return [];
}

function saveCampaign(campaign) {
  const campaigns = loadCampaigns();
  campaigns.push({ ...campaign, date: new Date().toISOString() });
  fs.writeFileSync(
    CAMPAIGNS_PATH,
    JSON.stringify(campaigns.slice(-50), null, 2),
    "utf8"
  );
}

// ─── Lecture fichiers projet ──────────────────────────────────────────────────
function readProjectFile(filePath) {
  try {
    return fs.readFileSync(path.join(PROJECT_PATH, filePath), "utf8");
  } catch {
    return null;
  }
}

function getProjectContext() {
  const raw = readProjectFile("data/products.json");
  const products = raw ? JSON.parse(raw) : [];
  const recentCampaigns = loadCampaigns().slice(-5);
  return { products, recentCampaigns };
}

function isAuthorized(userId) {
  if (!AUTHORIZED_USER) return true;
  return userId.toString() === AUTHORIZED_USER;
}

// ─── ÉTAPE 1 : Analyse & décomposition ───────────────────────────────────────
async function analyzePlan(instruction, context) {
  const { products, recentCampaigns } = context;

  const historique =
    recentCampaigns.length > 0
      ? recentCampaigns
          .map(
            (c) =>
              `- [${c.date?.split("T")[0]}] "${c.instruction}" → ${c.status}`
          )
          .join("\n")
      : "Aucune campagne précédente.";

  const system = `Tu es le Chef de Projet IA de PaceStore, boutique e-commerce running premium.
Tu coordonnes 4 agents spécialisés : Copywriter, Designer, Dev, Ads.
Catalogue produits : ${JSON.stringify(products) || "non disponible"}

Historique des campagnes récentes :
${historique}

Analyse l'instruction reçue et produis un plan d'action JSON structuré.
Réponds UNIQUEMENT avec ce JSON (aucun texte autour) :
{
  "titre": "Titre court du projet",
  "objectif": "Objectif principal en une phrase",
  "budget_estime": "€X-Y (ou N/A)",
  "duree_estimee": "X heures / X jours",
  "taches": [
    {
      "id": 1,
      "agent": "Copywriter | Designer | Dev | Ads",
      "titre": "Titre concis de la tâche",
      "description": "Ce que l'agent doit faire précisément",
      "output": "Livrable concret attendu",
      "delai": "X heures",
      "priorite": "haute | moyenne | basse"
    }
  ],
  "kpis": ["KPI 1", "KPI 2"],
  "risques": ["Risque éventuel"]
}`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2000,
    system,
    messages: [{ role: "user", content: instruction }],
  });

  const text = response.content[0].text.trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Réponse JSON invalide du planificateur");
  return JSON.parse(match[0]);
}

// ─── Formatage du plan pour Telegram ─────────────────────────────────────────
function formatPlan(plan, instruction) {
  const priorityIcon = { haute: "🔴", moyenne: "🟡", basse: "🟢" };

  let msg = `👔 *PLAN DE CAMPAGNE*\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n\n`;
  msg += `📌 *${plan.titre}*\n\n`;
  msg += `🎯 *Objectif :* ${plan.objectif}\n`;
  msg += `⏱ *Durée :* ${plan.duree_estimee}\n`;
  if (plan.budget_estime && plan.budget_estime !== "N/A") {
    msg += `💶 *Budget :* ${plan.budget_estime}\n`;
  }
  msg += `\n━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `📋 *TÂCHES — ${plan.taches.length} action(s)*\n\n`;

  for (const t of plan.taches) {
    const agent = AGENTS[t.agent] || { emoji: "⚙️" };
    const prio = priorityIcon[t.priorite] || "⚪";
    msg += `${prio} *${t.id}. ${agent.emoji} ${t.agent}* — _${t.titre}_\n`;
    msg += `   📤 ${t.output}\n`;
    msg += `   ⏱ ${t.delai}\n\n`;
  }

  if (plan.kpis?.length) {
    msg += `━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `📊 *KPIs*\n`;
    plan.kpis.forEach((k) => (msg += `• ${k}\n`));
  }

  if (plan.risques?.length) {
    msg += `\n⚠️ *Risques*\n`;
    plan.risques.forEach((r) => (msg += `• ${r}\n`));
  }

  msg += `\n━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `_Validez le plan ou demandez des modifications._`;

  return msg;
}

// ─── ÉTAPE 2 : Validation (boutons inline) ────────────────────────────────────
function validationKeyboard(chatId) {
  return {
    inline_keyboard: [
      [
        { text: "✅ Valider et lancer", callback_data: `ceo_validate_${chatId}` },
        { text: "✏️ Modifier", callback_data: `ceo_modify_${chatId}` },
      ],
    ],
  };
}

// ─── ÉTAPE 3 : Révision du plan ───────────────────────────────────────────────
async function revisePlan(feedback, pendingData) {
  const { plan, instruction } = pendingData;

  const system = `Tu es le Chef de Projet IA de PaceStore.
Tu as soumis un plan que Mounir souhaite modifier.

Plan actuel :
${JSON.stringify(plan, null, 2)}

Instruction originale : "${instruction}"

Applique fidèlement les modifications demandées et retourne le plan révisé au format JSON identique.
Réponds UNIQUEMENT avec le JSON.`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2000,
    system,
    messages: [{ role: "user", content: feedback }],
  });

  const text = response.content[0].text.trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Plan révisé invalide");
  return JSON.parse(match[0]);
}

// ─── ÉTAPE 4 : Exécution de chaque tâche ─────────────────────────────────────
async function executeTask(task, context) {
  const agent = AGENTS[task.agent];
  if (!agent) throw new Error(`Agent inconnu : ${task.agent}`);

  const systemPrompt = agent.systemPrompt(context.products);

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1500,
    system: systemPrompt,
    messages: [
      {
        role: "user",
        content: `**Tâche :** ${task.titre}\n\n**Description :** ${task.description}\n\n**Livrable attendu :** ${task.output}\n\nProduis le livrable complet et professionnel.`,
      },
    ],
  });

  return response.content[0].text.trim();
}

async function executePlan(chatId, plan, instruction) {
  const context = getProjectContext();

  await bot.sendMessage(
    chatId,
    `🚀 *Exécution du plan lancée*\n\n${plan.taches.length} tâches en cours de traitement...\n_Progression en temps réel ci-dessous._`,
    { parse_mode: "Markdown" }
  );

  const results = [];

  for (const task of plan.taches) {
    const agent = AGENTS[task.agent] || { emoji: "⚙️" };

    await bot.sendChatAction(chatId, "typing");
    await bot.sendMessage(
      chatId,
      `⏳ *[${task.id}/${plan.taches.length}]* ${agent.emoji} *${task.agent}* — _${task.titre}_`,
      { parse_mode: "Markdown" }
    );

    try {
      const output = await executeTask(task, context);
      results.push({ task, output, success: true });

      // Sauvegarde du livrable
      const timestamp = new Date().toISOString().split("T")[0];
      const fileName = `${timestamp}-t${task.id}-${task.agent.toLowerCase()}.md`;
      const filePath = path.join(
        PROJECT_PATH,
        "marketing",
        "campaigns",
        fileName
      );
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(
        filePath,
        `# ${task.titre}\n\n**Campagne :** ${instruction}  \n**Agent :** ${task.agent}  \n**Date :** ${new Date().toLocaleString("fr-FR")}\n\n---\n\n${output}`,
        "utf8"
      );

      // Aperçu tronqué pour Telegram
      const preview =
        output.length > 900
          ? output.substring(0, 900) + "\n\n_…[livrable complet sauvegardé]_"
          : output;

      await bot.sendMessage(
        chatId,
        `✅ *Tâche ${task.id} — ${agent.emoji} ${task.agent}*\n\n${preview}`,
        { parse_mode: "Markdown" }
      );
    } catch (e) {
      results.push({ task, success: false });
      await bot.sendMessage(
        chatId,
        `❌ *Tâche ${task.id} échouée*\n\`${e.message}\``,
        { parse_mode: "Markdown" }
      );
    }

    await new Promise((r) => setTimeout(r, 800));
  }

  // Rapport final
  const ok = results.filter((r) => r.success).length;
  const ko = results.filter((r) => !r.success).length;
  const status = ko === 0 ? "✅ Succès complet" : `⚠️ Partiel (${ko} échec)`;

  saveCampaign({
    instruction,
    titre: plan.titre,
    tasks_count: plan.taches.length,
    succeeded: ok,
    failed: ko,
    status,
  });

  await bot.sendMessage(
    chatId,
    `🏁 *Rapport final — ${plan.titre}*\n\n` +
      `✅ Réussies : ${ok}/${plan.taches.length}\n` +
      (ko > 0 ? `❌ Échecs : ${ko}\n` : "") +
      `\n📁 Livrables dans \`marketing/campaigns/\`\n\n` +
      `_Nouvelle campagne ? Envoyez votre instruction._`,
    { parse_mode: "Markdown" }
  );
}

// ─── Handlers Telegram ─────────────────────────────────────────────────────────

bot.onText(/\/start/, (msg) => {
  if (!isAuthorized(msg.from.id)) return;
  bot.sendMessage(
    msg.chat.id,
    `👔 *CEO Agent — PaceStore*\n\n` +
      `Je suis votre chef de projet IA. Envoyez une instruction de campagne et je :\n\n` +
      `1️⃣ Analyse et décompose en tâches\n` +
      `2️⃣ Présente un plan structuré\n` +
      `3️⃣ Attends votre validation\n` +
      `4️⃣ Orchestre l'exécution par agent\n\n` +
      `*Exemples :*\n` +
      `• _"Lance une campagne trail ce weekend"_\n` +
      `• _"Prépare une promo chaussures -20% pour lundi"_\n` +
      `• _"Crée une série de contenus Instagram running"_\n\n` +
      `Agents disponibles : 🖊️ Copywriter · 🎨 Designer · 💻 Dev · 📣 Ads`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/historique/, (msg) => {
  if (!isAuthorized(msg.from.id)) return;
  const campaigns = loadCampaigns();
  if (campaigns.length === 0) {
    bot.sendMessage(msg.chat.id, "📋 Aucune campagne en mémoire.");
    return;
  }
  const last10 = campaigns.slice(-10).reverse();
  const lines = last10
    .map(
      (c) =>
        `• [${c.date?.split("T")[0]}] *${c.titre || c.instruction}* — ${c.status}`
    )
    .join("\n");
  bot.sendMessage(
    msg.chat.id,
    `📋 *Historique des campagnes*\n\n${lines}`,
    { parse_mode: "Markdown" }
  );
});

// Boutons inline : validation ou modification
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  if (!isAuthorized(query.from.id)) {
    await bot.answerCallbackQuery(query.id, { text: "⛔ Accès non autorisé" });
    return;
  }

  await bot.answerCallbackQuery(query.id);

  // Retire les boutons du message
  await bot
    .editMessageReplyMarkup(
      { inline_keyboard: [] },
      { chat_id: chatId, message_id: query.message.message_id }
    )
    .catch(() => {});

  if (data.startsWith("ceo_validate_")) {
    const pending = pendingPlans[chatId];
    if (!pending) {
      await bot.sendMessage(chatId, "❌ Aucun plan en attente.");
      return;
    }
    const { plan, instruction } = pending;
    delete pendingPlans[chatId];

    await bot.sendMessage(chatId, "✅ *Plan validé.*", {
      parse_mode: "Markdown",
    });
    await executePlan(chatId, plan, instruction);
  } else if (data.startsWith("ceo_modify_")) {
    const pending = pendingPlans[chatId];
    if (!pending) {
      await bot.sendMessage(chatId, "❌ Aucun plan en attente.");
      return;
    }
    pendingPlans[chatId].waitingForFeedback = true;
    await bot.sendMessage(
      chatId,
      `✏️ *Quelles modifications souhaitez-vous ?*\n\n_Décrivez les ajustements à apporter :_`,
      { parse_mode: "Markdown" }
    );
  }
});

// Messages texte
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  if (!isAuthorized(msg.from.id)) {
    await bot.sendMessage(chatId, "⛔ Accès non autorisé.");
    return;
  }
  if (!msg.text || msg.text.startsWith("/")) return;

  const instruction = msg.text.trim();

  // Feedback de modification en attente
  if (pendingPlans[chatId]?.waitingForFeedback) {
    pendingPlans[chatId].waitingForFeedback = false;
    await bot.sendChatAction(chatId, "typing");
    await bot.sendMessage(chatId, "🔄 *Révision du plan...*", {
      parse_mode: "Markdown",
    });

    try {
      const revisedPlan = await revisePlan(instruction, pendingPlans[chatId]);
      pendingPlans[chatId] = {
        plan: revisedPlan,
        instruction: pendingPlans[chatId].instruction,
        waitingForFeedback: false,
      };
      await bot.sendMessage(chatId, formatPlan(revisedPlan, pendingPlans[chatId].instruction), {
        parse_mode: "Markdown",
        reply_markup: validationKeyboard(chatId),
      });
    } catch (e) {
      console.error(e);
      await bot.sendMessage(chatId, "❌ Erreur lors de la révision. Réessayez.");
    }
    return;
  }

  // Nouvelle instruction → générer un plan
  await bot.sendChatAction(chatId, "typing");
  await bot.sendMessage(
    chatId,
    `🧠 *Analyse en cours...*\n_Décomposition de votre instruction en tâches._`,
    { parse_mode: "Markdown" }
  );

  try {
    const context = getProjectContext();
    const plan = await analyzePlan(instruction, context);
    pendingPlans[chatId] = { plan, instruction, waitingForFeedback: false };

    await bot.sendMessage(chatId, formatPlan(plan, instruction), {
      parse_mode: "Markdown",
      reply_markup: validationKeyboard(chatId),
    });
  } catch (e) {
    console.error(e);
    await bot.sendMessage(
      chatId,
      "❌ Erreur lors de l'analyse. Réessayez ou reformulez l'instruction."
    );
  }
});

console.log("👔 CEO Agent PaceStore démarré");
