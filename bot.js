require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs");
const path = require("path");

// ─── Init ─────────────────────────────────────────────────────────────────────
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const AUTHORIZED_USER = process.env.TELEGRAM_USER_ID;
const PROJECT_PATH = process.env.PROJECT_PATH || "../pacestore";
const ROOT = __dirname;
const CAMPAIGNS_PATH = path.join(ROOT, "campaigns.json");

// ─── État par conversation ────────────────────────────────────────────────────
const conversationHistory = {}; // chatId → [{role, content}]  (mode assistant)
const pendingPlans = {};        // chatId → {plan, instruction, waitingForFeedback}

// ─── Agents CEO ───────────────────────────────────────────────────────────────
const AGENTS = {
  Copywriter: {
    emoji: "🖊️",
    systemPrompt: (products) =>
      `Tu es le Copywriter senior de PaceStore, boutique e-commerce running premium.
Identité : noir #0A0A0A, orange #FF5C00. Ton : expert running, direct, énergique.
Catalogue : ${JSON.stringify(products)}. Réponds en français.`,
  },
  Designer: {
    emoji: "🎨",
    systemPrompt: () =>
      `Tu es le Directeur Artistique de PaceStore (running premium, noir #0A0A0A, orange #FF5C00).
Produis des briefs créatifs ultra-détaillés : dimensions, couleurs hex, typo, composition, références. Réponds en français.`,
  },
  Dev: {
    emoji: "💻",
    systemPrompt: () =>
      `Tu es le Lead Developer de PaceStore (e-commerce running, Next.js/React).
Fournis des spécifications techniques précises et du code si nécessaire. Réponds en français.`,
  },
  Ads: {
    emoji: "📣",
    systemPrompt: (products) =>
      `Tu es le Media Buyer de PaceStore (running premium).
Produis des stratégies média : plateformes, ciblages, budgets, formats, copies.
Catalogue : ${JSON.stringify(products)}. Réponds en français.`,
  },
};

// ─── Helpers fichiers ─────────────────────────────────────────────────────────
function readFile(filePath) {
  try { return fs.readFileSync(path.join(PROJECT_PATH, filePath), "utf8"); }
  catch { return null; }
}

function writeFile(filePath, content) {
  try {
    const fullPath = path.join(PROJECT_PATH, filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, "utf8");
    return true;
  } catch { return false; }
}

function getProducts() {
  const raw = readFile("data/products.json");
  return raw ? JSON.parse(raw) : [];
}

function isAuthorized(userId) {
  if (!AUTHORIZED_USER) return true;
  return userId.toString() === AUTHORIZED_USER;
}

// ─── Mémoire campagnes ────────────────────────────────────────────────────────
function loadCampaigns() {
  try {
    if (fs.existsSync(CAMPAIGNS_PATH))
      return JSON.parse(fs.readFileSync(CAMPAIGNS_PATH, "utf8"));
  } catch {}
  return [];
}

function saveCampaign(campaign) {
  const list = loadCampaigns();
  list.push({ ...campaign, date: new Date().toISOString() });
  fs.writeFileSync(CAMPAIGNS_PATH, JSON.stringify(list.slice(-50), null, 2), "utf8");
}

// ─── Détection automatique du mode ───────────────────────────────────────────
async function isCampaignInstruction(text) {
  // Pré-filtre rapide : si aucun mot-clé d'action ou de campagne → mode assistant
  const hasKeyword = /\b(lance|lancer|lanc[eo]|crée|créer|prépare|préparer|démarre|organise|génère|mets en place|fais tourner|campagne|promo|promotion|stratégie|brief|opération|série de|plan de|publicité|ads|newsletter|email marketing|contenu|posts?)\b/i.test(text);
  if (!hasKeyword) return false;

  // Classification fine via Claude (très rapide)
  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 5,
    system: `Tu analyses des messages envoyés à un bot Telegram e-commerce running.
Réponds uniquement "OUI" ou "NON".
OUI = instruction de campagne/projet marketing à orchestrer (demande de lancer, créer, préparer quelque chose de concret).
NON = question, conversation, demande d'information ou tâche ponctuelle simple.`,
    messages: [{ role: "user", content: text }],
  });

  return response.content[0].text.trim().toUpperCase().startsWith("OUI");
}

// ─── MODE ASSISTANT (comportement original) ───────────────────────────────────
async function processMessage(chatId, userMessage) {
  if (!conversationHistory[chatId]) conversationHistory[chatId] = [];
  conversationHistory[chatId].push({ role: "user", content: userMessage });
  if (conversationHistory[chatId].length > 20)
    conversationHistory[chatId] = conversationHistory[chatId].slice(-20);

  const products = readFile("data/products.json");
  const system = `Tu es l'agent IA de PaceStore, boutique e-commerce running premium.
Tu peux : modifier le catalogue produits, générer du copywriting, créer des scripts ads Meta/TikTok/Google, générer des briefs créatifs.
Identité : noir #0A0A0A, orange #FF5C00. Ton : expert running, direct.
Réponds en français. Sois concis et efficace.

Catalogue actuel :
${products || "vide"}`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2000,
    system,
    messages: conversationHistory[chatId],
  });

  const reply = response.content[0].text;
  conversationHistory[chatId].push({ role: "assistant", content: reply });

  const timestamp = new Date().toISOString().split("T")[0];
  if (/\b(ads|script)\b/i.test(userMessage))
    writeFile(`marketing/ads/ads-${timestamp}.md`, `# ${userMessage}\n\n${reply}`);
  if (/\b(fiche|copy)\b/i.test(userMessage))
    writeFile(`marketing/copy/copy-${timestamp}.md`, `# ${userMessage}\n\n${reply}`);

  return reply;
}

// ─── MODE CEO : analyse & planification ──────────────────────────────────────
async function analyzePlan(instruction) {
  const products = getProducts();
  const recent = loadCampaigns().slice(-5);

  const historique = recent.length
    ? recent.map((c) => `- [${c.date?.split("T")[0]}] "${c.instruction}" → ${c.status}`).join("\n")
    : "Aucune campagne précédente.";

  const system = `Tu es le Chef de Projet IA de PaceStore, boutique e-commerce running premium.
Tu coordonnes 4 agents : Copywriter, Designer, Dev, Ads.
Catalogue : ${JSON.stringify(products)}

Historique récent :
${historique}

Réponds UNIQUEMENT avec ce JSON (aucun texte autour) :
{
  "titre": "Titre court",
  "objectif": "Objectif en une phrase",
  "budget_estime": "€X-Y ou N/A",
  "duree_estimee": "X heures / X jours",
  "taches": [
    {
      "id": 1,
      "agent": "Copywriter | Designer | Dev | Ads",
      "titre": "Titre concis",
      "description": "Ce que l'agent doit faire précisément",
      "output": "Livrable concret attendu",
      "delai": "X heures",
      "priorite": "haute | moyenne | basse"
    }
  ],
  "kpis": ["KPI 1"],
  "risques": ["Risque éventuel"]
}`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2000,
    system,
    messages: [{ role: "user", content: instruction }],
  });

  const match = response.content[0].text.trim().match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Réponse JSON invalide du planificateur");
  return JSON.parse(match[0]);
}

function formatPlan(plan, instruction) {
  const prio = { haute: "🔴", moyenne: "🟡", basse: "🟢" };

  let msg = `👔 *PLAN DE CAMPAGNE*\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n\n`;
  msg += `📌 *${plan.titre}*\n\n`;
  msg += `🎯 *Objectif :* ${plan.objectif}\n`;
  msg += `⏱ *Durée :* ${plan.duree_estimee}\n`;
  if (plan.budget_estime && plan.budget_estime !== "N/A")
    msg += `💶 *Budget :* ${plan.budget_estime}\n`;
  msg += `\n━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `📋 *TÂCHES — ${plan.taches.length} action(s)*\n\n`;

  for (const t of plan.taches) {
    const agent = AGENTS[t.agent] || { emoji: "⚙️" };
    msg += `${prio[t.priorite] || "⚪"} *${t.id}. ${agent.emoji} ${t.agent}* — _${t.titre}_\n`;
    msg += `   📤 ${t.output}\n`;
    msg += `   ⏱ ${t.delai}\n\n`;
  }

  if (plan.kpis?.length) {
    msg += `━━━━━━━━━━━━━━━━━━━━\n📊 *KPIs*\n`;
    plan.kpis.forEach((k) => (msg += `• ${k}\n`));
  }
  if (plan.risques?.length) {
    msg += `\n⚠️ *Risques*\n`;
    plan.risques.forEach((r) => (msg += `• ${r}\n`));
  }

  msg += `\n━━━━━━━━━━━━━━━━━━━━\n_Validez le plan ou demandez des modifications._`;
  return msg;
}

function validationKeyboard(chatId) {
  return {
    inline_keyboard: [[
      { text: "✅ Valider et lancer", callback_data: `ceo_validate_${chatId}` },
      { text: "✏️ Modifier",          callback_data: `ceo_modify_${chatId}` },
    ]],
  };
}

// ─── MODE CEO : révision du plan ─────────────────────────────────────────────
async function revisePlan(feedback, pending) {
  const system = `Tu es le Chef de Projet IA de PaceStore.
Plan actuel :
${JSON.stringify(pending.plan, null, 2)}

Instruction originale : "${pending.instruction}"

Applique fidèlement les modifications demandées et retourne le plan révisé au format JSON identique.
Réponds UNIQUEMENT avec le JSON.`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2000,
    system,
    messages: [{ role: "user", content: feedback }],
  });

  const match = response.content[0].text.trim().match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Plan révisé invalide");
  return JSON.parse(match[0]);
}

// ─── MODE CEO : exécution des tâches ─────────────────────────────────────────
async function executeTask(task, products) {
  const agent = AGENTS[task.agent];
  if (!agent) throw new Error(`Agent inconnu : ${task.agent}`);

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1500,
    system: agent.systemPrompt(products),
    messages: [{
      role: "user",
      content: `**Tâche :** ${task.titre}\n**Description :** ${task.description}\n**Livrable attendu :** ${task.output}\n\nProduis le livrable complet et professionnel.`,
    }],
  });

  return response.content[0].text.trim();
}

async function executePlan(chatId, plan, instruction) {
  const products = getProducts();

  await bot.sendMessage(
    chatId,
    `🚀 *Exécution lancée — ${plan.taches.length} tâche(s)*\n_Progression en temps réel ci-dessous._`,
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
      const output = await executeTask(task, products);
      results.push({ task, success: true });

      // Sauvegarde livrable
      const ts = new Date().toISOString().split("T")[0];
      writeFile(
        `marketing/campaigns/${ts}-t${task.id}-${task.agent.toLowerCase()}.md`,
        `# ${task.titre}\n\n**Campagne :** ${instruction}  \n**Agent :** ${task.agent}  \n**Date :** ${new Date().toLocaleString("fr-FR")}\n\n---\n\n${output}`
      );

      const preview = output.length > 900
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

  const ok = results.filter((r) => r.success).length;
  const ko = results.filter((r) => !r.success).length;
  const status = ko === 0 ? "✅ Succès complet" : `⚠️ Partiel (${ko} échec)`;

  saveCampaign({ instruction, titre: plan.titre, tasks_count: plan.taches.length, succeeded: ok, failed: ko, status });

  await bot.sendMessage(
    chatId,
    `🏁 *Rapport final — ${plan.titre}*\n\n` +
    `✅ Réussies : ${ok}/${plan.taches.length}\n` +
    (ko > 0 ? `❌ Échecs : ${ko}\n` : "") +
    `\n📁 Livrables dans \`marketing/campaigns/\`\n\n` +
    `_Nouvelle instruction ? Je suis prêt._`,
    { parse_mode: "Markdown" }
  );
}

// ─── Commandes ────────────────────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  if (!isAuthorized(msg.from.id)) return;
  bot.sendMessage(msg.chat.id,
    `👟 *PaceStore Agent actif*\n\n` +
    `Je bascule automatiquement en **Chef de Projet** quand vous lancez une campagne ou un projet, et reste en assistant pour le reste.\n\n` +
    `*Mode assistant :*\n• Catalogue produits\n• Copywriting\n• Scripts ads\n• Briefs créatifs\n\n` +
    `*Mode Chef de Projet :*\n• Analyse & plan détaillé\n• Validation avant exécution\n• 🖊️ Copywriter · 🎨 Designer · 💻 Dev · 📣 Ads\n\n` +
    `Exemples de campagnes :\n_"Lance une campagne trail ce weekend"_\n_"Prépare une promo -20% pour lundi"_`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/status/, (msg) => {
  if (!isAuthorized(msg.from.id)) return;
  const products = readFile("data/products.json");
  const count = products ? JSON.parse(products).length : 0;
  const campaigns = loadCampaigns();
  bot.sendMessage(msg.chat.id,
    `📊 *Status*\n\nProduits : ${count}\nCampagnes en mémoire : ${campaigns.length}\nAgent : ✅ actif`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/reset/, (msg) => {
  if (!isAuthorized(msg.from.id)) return;
  conversationHistory[msg.chat.id] = [];
  delete pendingPlans[msg.chat.id];
  bot.sendMessage(msg.chat.id, "🔄 Conversation et plan réinitialisés.");
});

bot.onText(/\/historique/, (msg) => {
  if (!isAuthorized(msg.from.id)) return;
  const campaigns = loadCampaigns();
  if (!campaigns.length) { bot.sendMessage(msg.chat.id, "📋 Aucune campagne en mémoire."); return; }
  const lines = campaigns.slice(-10).reverse()
    .map((c) => `• [${c.date?.split("T")[0]}] *${c.titre || c.instruction}* — ${c.status}`)
    .join("\n");
  bot.sendMessage(msg.chat.id, `📋 *Historique des campagnes*\n\n${lines}`, { parse_mode: "Markdown" });
});

// ─── Boutons inline (validation CEO) ─────────────────────────────────────────
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  if (!isAuthorized(query.from.id)) {
    await bot.answerCallbackQuery(query.id, { text: "⛔ Accès non autorisé" });
    return;
  }

  await bot.answerCallbackQuery(query.id);
  await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
    chat_id: chatId, message_id: query.message.message_id,
  }).catch(() => {});

  if (data.startsWith("ceo_validate_")) {
    const pending = pendingPlans[chatId];
    if (!pending) { await bot.sendMessage(chatId, "❌ Aucun plan en attente."); return; }
    const { plan, instruction } = pending;
    delete pendingPlans[chatId];
    await bot.sendMessage(chatId, "✅ *Plan validé.*", { parse_mode: "Markdown" });
    await executePlan(chatId, plan, instruction);

  } else if (data.startsWith("ceo_modify_")) {
    if (!pendingPlans[chatId]) { await bot.sendMessage(chatId, "❌ Aucun plan en attente."); return; }
    pendingPlans[chatId].waitingForFeedback = true;
    await bot.sendMessage(
      chatId,
      `✏️ *Quelles modifications souhaitez-vous ?*\n\n_Décrivez les ajustements à apporter :_`,
      { parse_mode: "Markdown" }
    );
  }
});

// ─── Handler principal ────────────────────────────────────────────────────────
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;

  if (!isAuthorized(msg.from.id)) { bot.sendMessage(chatId, "⛔ Accès non autorisé."); return; }
  if (!msg.text || msg.text.startsWith("/")) return;

  const text = msg.text.trim();

  // ── Feedback de modification en attente ───────────────────────────────────
  if (pendingPlans[chatId]?.waitingForFeedback) {
    pendingPlans[chatId].waitingForFeedback = false;
    await bot.sendChatAction(chatId, "typing");
    await bot.sendMessage(chatId, "🔄 *Révision du plan...*", { parse_mode: "Markdown" });
    try {
      const revised = await revisePlan(text, pendingPlans[chatId]);
      pendingPlans[chatId] = { plan: revised, instruction: pendingPlans[chatId].instruction, waitingForFeedback: false };
      await bot.sendMessage(chatId, formatPlan(revised, pendingPlans[chatId].instruction), {
        parse_mode: "Markdown",
        reply_markup: validationKeyboard(chatId),
      });
    } catch (e) {
      console.error(e);
      await bot.sendMessage(chatId, "❌ Erreur lors de la révision. Réessayez.");
    }
    return;
  }

  // ── Détection automatique du mode ─────────────────────────────────────────
  await bot.sendChatAction(chatId, "typing");

  let ceoMode = false;
  try {
    ceoMode = await isCampaignInstruction(text);
  } catch {
    ceoMode = false; // En cas d'erreur de classification → mode assistant par défaut
  }

  // ── Mode Chef de Projet ────────────────────────────────────────────────────
  if (ceoMode) {
    await bot.sendMessage(
      chatId,
      `🧠 *Analyse en cours...*\n_Décomposition de votre instruction en tâches._`,
      { parse_mode: "Markdown" }
    );
    try {
      const plan = await analyzePlan(text);
      pendingPlans[chatId] = { plan, instruction: text, waitingForFeedback: false };
      await bot.sendMessage(chatId, formatPlan(plan, text), {
        parse_mode: "Markdown",
        reply_markup: validationKeyboard(chatId),
      });
    } catch (e) {
      console.error(e);
      await bot.sendMessage(chatId, "❌ Erreur lors de l'analyse. Réessayez ou reformulez.");
    }
    return;
  }

  // ── Mode Assistant ─────────────────────────────────────────────────────────
  try {
    const reply = await processMessage(chatId, text);
    const chunks = reply.match(/[\s\S]{1,4000}/g) || [];
    for (const chunk of chunks)
      await bot.sendMessage(chatId, chunk, { parse_mode: "Markdown" });
  } catch (e) {
    console.error(e);
    bot.sendMessage(chatId, "❌ Erreur. Réessaie.");
  }
});

console.log("🤖 PaceStore Agent démarré (assistant + chef de projet)");
