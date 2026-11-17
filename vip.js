import TelegramBot from "node-telegram-bot-api";
import { MongoClient } from "mongodb";
import dotenv from "dotenv";
import getSteamid from "./utils/getSteamid.js";
import vipCreater from "./utils/vipCreater.js";
import fs from "fs";
import { prepareDonationLink } from "./utils/donationLinkAudit.js";
import { installStarsBot } from "./utils/starsBot.js";
dotenv.config();

const bot = new TelegramBot(process.env.BOT_TOKEN, {
  polling: { autoStart: false, interval: 1500, params: { timeout: 20 } },
  request: { proxy: process.env.TELEGRAM_PROXY_URL || process.env.DISCORD_PROXY_URL, timeout: 30000 },
});
bot.on('polling_error', error => console.warn('[Telegram] polling: ' + (error.code || error.name)));
const mongo = new MongoClient(process.env.MONGO_URL);

let steamCollection;
const waitForSteam = new Map();

const vipText = `
<b>Поддержите Русский Народный Сервер</b>

Вы можете добровольно поддержать работу и развитие наших игровых серверов любой суммой.

Спасибо всем, кто помогает проекту оставаться доступным для игроков!

`;

await mongo.connect();
steamCollection = mongo.db("SquadJS").collection("mainstats");
await installStarsBot(bot, mongo.db("SquadJS"), { onBegin: chatId => waitForSteam.delete(chatId) });
console.log("MongoDB connected; Stars payments ready");

async function sendDonationLink(chatId, actorId, steamId) {
  try {
    const prepared = await prepareDonationLink(mongo.db("SquadJS"), { platform: "telegram", actorId, steamId, configuredUrl: process.env.DONATION_LINK });
    await bot.sendMessage(chatId, `Ваш SteamID: ${steamId}\nСкопируйте его. На DonatePay полностью очистите поле «Сообщение стримеру» и вставьте этот SteamID. Перед оплатой проверьте: в поле должен быть только ваш ID. Сайт может показывать чужой ID — не оставляйте его.`, {
      reply_markup: { inline_keyboard: [[{ text: "Поддержать проект", url: prepared.url }]] }
    });
    await prepared.delivered();
  } catch (error) {
    console.warn('[donation-link] Failed to prepare or deliver audited link');
    await bot.sendMessage(chatId, 'Не удалось подготовить ссылку на донат. Попробуйте позже.');
  }
}

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  await bot.sendMessage(chatId, vipText, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "Поддержать проект ⭐", callback_data: "stars_vip" }],
        [{ text: "Поддержать через DonatePay", callback_data: "donate" }],
        [{ text: "🎁 VIP за бонусные баллы", callback_data: "bonus" }],
        [{ text: "🧐 Проверить VIP", callback_data: "check_vip" }],
      ],
    },
  });
});

bot.on("callback_query", async (query) => {
  await bot.answerCallbackQuery(query.id).catch(error => console.warn('[Telegram] callback: ' + (error.code || error.name)));
  const chatId = query.message?.chat?.id;
  if (!chatId) return;
  if (query.data?.startsWith('stars_')) { waitForSteam.delete(chatId); return; }

  if (query.data === "donate") {
    if (query.message.chat.type !== "private") return bot.sendMessage(chatId, "Для оформления доната откройте личный чат с ботом.");
    const user = await steamCollection.findOne({
      telegramid: chatId.toString(),
    });
    if (user && user._id) {
      return sendDonationLink(chatId, query.from.id, user._id);
    } else {
      waitForSteam.set(chatId, "donate");
      return bot.sendMessage(
        chatId,
        "Отправьте свой SteamID64 (17 цифр) или ссылку на профиль Steam:"
      );
    }
  }

  if (query.data === "bonus") {
    const dbUser = await steamCollection.findOne({
      telegramid: chatId.toString(),
    });

    if (!dbUser) {
      return bot.sendMessage(
        chatId,
        "Чтобы получить VIP за бонусные баллы, привяжите свой Steam профиль к Telegram.",
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "Привязать SteamID",
                  callback_data: "bind_steam_for_bonus",
                },
              ],
            ],
          },
        }
      );
    }
    const { bonuses = 0, _id: steamid, name } = dbUser;

    if (bonuses < 15000) {
      return bot.sendMessage(
        chatId,
        `Не хватает ${
          15000 - bonuses
        } бонусных баллов для получения VIP статуса, требуется 15000.`
      );
    }
    await steamCollection.updateOne(
      { _id: steamid },
      {
        $inc: { bonuses: -15000 },
      }
    );

    await vipCreater(steamid, name || steamid, 30, chatId);

    await bot.sendMessage(
      chatId,
      "🎉 VIP статус успешно получен за бонусные баллы!\nСтатус активирован, проверьте в игре после смены карты."
    );
    return;
  }

  if (query.data === "bind_steam_for_bonus") {
    waitForSteam.set(chatId, "bonus");
    return bot.sendMessage(
      chatId,
      "Пожалуйста, отправьте свой SteamID64 (17 цифр) или ссылку на профиль Steam:"
    );
  }

  if (query.data === "check_vip") {
    const user = await steamCollection.findOne({
      telegramid: chatId.toString(),
    });

    if (!user || !user._id) {
      return bot.sendMessage(chatId, "Вы ещё не привязали SteamID!");
    }

    const { _id: steamID, vipEndDate } = user;

    if (!(vipEndDate instanceof Date)) {
      return bot.sendMessage(chatId, "VIP не найден или срок действия истёк.");
    }

    const now = new Date();
    if (vipEndDate <= now) {
      return bot.sendMessage(chatId, "Срок действия VIP истёк.");
    }

    const msLeft = vipEndDate.getTime() - now.getTime();
    const daysLeft = Math.max(0, Math.ceil(msLeft / (1000 * 60 * 60 * 24)));

    const dd = String(vipEndDate.getDate()).padStart(2, "0");
    const mm = String(vipEndDate.getMonth() + 1).padStart(2, "0");
    const yyyy = vipEndDate.getFullYear();
    const dateStr = `${dd}.${mm}.${yyyy}`;

    let text = `✅ Ваш VIP активен до ${dateStr}`;
    if (daysLeft > 0) {
      text += `\n⏳ Осталось дней: ${daysLeft}`;
    }

    return bot.sendMessage(chatId, text);
  }
});

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  if (!msg.text || msg.text.startsWith("/")) return;

  const mode = waitForSteam.get(chatId);
  if (!mode) return;

  const input = msg.text.trim();
  const steamid = await getSteamid(process.env.STEAM_API_KEY, input);

  if (!steamid) {
    return bot.sendMessage(
      chatId,
      "❌ Не удалось распознать SteamID. Попробуйте снова."
    );
  }

  const user = await steamCollection.findOne({ _id: steamid });
  if (user && user.telegramid) {
    return bot.sendMessage(
      chatId,
      "Этот SteamID уже привязан к другому Telegram. Если это ошибка — обратитесь к администрации."
    );
  }

  await steamCollection.updateOne(
    { _id: steamid },
    { $set: { telegramid: chatId.toString() } },
    { upsert: true }
  );
  waitForSteam.delete(chatId);

  if (mode === "donate") {
    return sendDonationLink(chatId, msg.from.id, steamid);
  }
  if (mode === "bonus") {
    const dbUser = await steamCollection.findOne({ _id: steamid });
    const { bonuses = 0, name } = dbUser;
    if (bonuses < 15000) {
      return bot.sendMessage(
        chatId,
        `Привязка прошла успешно! Не хватает ${
          15000 - bonuses
        } бонусных баллов для получения VIP статуса.`
      );
    }

    await steamCollection.updateOne(
      { _id: steamid },
      {
        $inc: { bonuses: -15000 },
      }
    );

    await vipCreater(steamid, name || steamid, 30, chatId);

    return bot.sendMessage(
      chatId,
      "✅ Привязка прошла успешно! VIP статус сразу получен за бонусные баллы!"
    );
  }
});

console.log("VIP-бот запущен! node-telegram-bot-api");
bot.startPolling().catch(error => console.warn('[Telegram] start polling: ' + (error.code || error.name)));
