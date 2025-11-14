import TelegramBot from "node-telegram-bot-api";
import { MongoClient } from "mongodb";
import dotenv from "dotenv";
import getSteamid from "./utils/getSteamid.js";
import vipCreater from "./utils/vipCreater.js";
import fs from "fs";
dotenv.config();

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const mongo = new MongoClient(process.env.MONGO_URL);

let steamCollection;
const waitForSteam = new Map();

const vipText = `
<b>Уважаемые игроки Русского Народного Сервера!</b>

Вы можете <b>добровольно сделать пожертвование</b> на развитие и поддержание наших игровых серверов.

<b>В знак признательности</b> за вашу поддержку мы можем предоставить вам <b>VIP статус</b>.

<b>VIP статус:</b>
• приоритетный доступ на сервер — без ожидания;
• право голоса за выбор карты.

<b>Пожертвования:</b>
• <b>300 рублей</b> — VIP на 1 месяц;
• <b>2000 рублей</b> — клановый VIP на 1 месяц (до 30 человек).

<b>Всё является пожертвованием!</b> VIP — лишь благодарность за поддержку.

<b>Бонусная система:</b>
• 1 балл — 1 минута на обычной карте, 2 балла — 1 минута на seed-карте.
• 15000 баллов = VIP на месяц (команда !bonus в игре).
`;

(async () => {
  await mongo.connect();
  steamCollection = mongo.db("SquadJS").collection("mainstats");
  console.log("MongoDB connected");
})();

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  await bot.sendMessage(chatId, vipText, { parse_mode: "HTML" });
  await bot.sendMessage(chatId, "Выберите действие:", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "💎 VIP статус за донат", callback_data: "donate" }],
        [{ text: "🎁 VIP за бонусные баллы", callback_data: "bonus" }],
        [{ text: "🧐 Проверить VIP", callback_data: "check_vip" }],
      ],
    },
  });
});

bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;

  if (query.data === "donate") {
    const user = await steamCollection.findOne({
      telegramid: chatId.toString(),
    });
    if (user && user._id) {
      const link = `${process.env.DONATION_LINK}${user._id}`;
      return bot.sendMessage(
        chatId,
        "Для оформления доната нажмите кнопку ниже:",
        {
          reply_markup: {
            inline_keyboard: [[{ text: "💳 Оформить донат", url: link }]],
          },
        }
      );
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
    const link = `${process.env.DONATION_LINK}${steamid}`;
    return bot.sendMessage(
      chatId,
      `✅ Привязка прошла успешно!\n\nОформить донат: [НАЖМИ СЮДА](${link})`,
      { parse_mode: "Markdown", disable_web_page_preview: true }
    );
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
