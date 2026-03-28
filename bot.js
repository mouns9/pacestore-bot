require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs");
const path = require("path");

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const AUTHORIZED_USER = process.env.TELEGRAM_USER_ID;
const PROJECT_PATH = process.env.PROJECT_PATH || "../pacestore";
const conversationHistory = {};

const SYSTEM_PROMPT = `Tu es l'agent IA de PaceStore, boutique e-commerce running premium.
Tu peux : modifier le catalogue produits, générer du copywriting, créer des scripts ads Meta/TikTok/Google, générer des briefs créatifs.
Identité : noir #0A0A0A, orange #FF5C00. Ton : expert running, direct.
Réponds en français. Sois concis et efficace.`;

function readFile(filePath) {
  try { return fs.readFileSync(path.join(PROJECT_PATH, filePath), "utf8"); }
  catch(e) { return null; }
}

function writeFile(filePath, content) {
  try {
    const fullPath = path.join(PROJECT_PATH, filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, "utf8");
    return true;
  } catch(e) { return false; }
}

function isAuthorized(userId) {
  if (!AUTHORIZED_USER) return true;
  return userId.toString() === AUTHORIZED_USER;
}

async function processMessage(chatId, userMessage) {
  if (!conversationHistory[chatId]) conversationHistory[chatId] = [];
  conversationHistory[chatId].push({ role: "user", content: userMessage });
  if (conversationHistory[chatId].length > 20)
    conversationHistory[chatId] = conversationHistory[chatId].slice(-20);

  const products = readFile("data/products.json");
  const system = `${SYSTEM_PROMPT}\n\nCatalogue actuel:\n${products || "vide"}`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2000,
    system,
    messages: conversationHistory[chatId],
  });

  const reply = response.content[0].text;
  conversationHistory[chatId].push({ role: "assistant", content: reply });

  const timestamp = new Date().toISOString().split("T")[0];
  if (userMessage.toLowerCase().includes("ads") || userMessage.toLowerCase().includes("script"))
    writeFile(`marketing/ads/ads-${timestamp}.md`, `# ${userMessage}\n\n${reply}`);
  if (userMessage.toLowerCase().includes("fiche") || userMessage.toLowerCase().includes("copy"))
    writeFile(`marketing/copy/copy-${timestamp}.md`, `# ${userMessage}\n\n${reply}`);

  return reply;
}

bot.onText(/\/start/, (msg) => {
  if (!isAuthorized(msg.from.id)) return;
  bot.sendMessage(msg.chat.id,
    `👟 *PaceStore Agent actif*\n\nJe peux :\n• Modifier le catalogue\n• Générer du copywriting\n• Créer des scripts ads\n• Générer des briefs créatifs\n\nEnvoie ta tâche directement.`,
    { parse_mode: "Markdown" });
});

bot.onText(/\/status/, (msg) => {
  if (!isAuthorized(msg.from.id)) return;
  const products = readFile("data/products.json");
  const count = products ? JSON.parse(products).length : 0;
  bot.sendMessage(msg.chat.id, `📊 *Status*\n\nProduits : ${count}\nAgent : ✅ actif`, { parse_mode: "Markdown" });
});

bot.onText(/\/reset/, (msg) => {
  if (!isAuthorized(msg.from.id)) return;
  conversationHistory[msg.chat.id] = [];
  bot.sendMessage(msg.chat.id, "🔄 Conversation réinitialisée.");
});

bot.on("message", async (msg) => {
  if (!isAuthorized(msg.from.id)) { bot.sendMessage(msg.chat.id, "⛔ Accès non autorisé."); return; }
  if (!msg.text || msg.text.startsWith("/")) return;
  bot.sendChatAction(msg.chat.id, "typing");
  try {
    const reply = await processMessage(msg.chat.id, msg.text);
    if (reply.length > 4000) {
      const chunks = reply.match(/[\s\S]{1,4000}/g);
      for (const chunk of chunks)
        await bot.sendMessage(msg.chat.id, chunk, { parse_mode: "Markdown" });
    } else {
      await bot.sendMessage(msg.chat.id, reply, { parse_mode: "Markdown" });
    }
  } catch(e) {
    console.error(e);
    bot.sendMessage(msg.chat.id, "❌ Erreur. Réessaie.");
  }
});

console.log("🤖 PaceStore Agent démarré");
