// utils/vipCreater.js
import fs from "fs";
import { exec } from "child_process";
import path from "path";
import { MongoClient } from "mongodb";
import dotenv from "dotenv";
dotenv.config();

const ADMINS_CFG_PATH = process.env.ADMINS_CFG_PATH || "./Admins.cfg";
const ADMINS_CFG_BACKUPS = process.env.ADMINS_CFG_BACKUPS || "./backups";
const SYNC_CONFIG_PATH = process.env.SYNC_CONFIG_PATH || "";
const MONGO_URL = process.env.MONGO_URL;
const DB_NAME = "SquadJS";
const DB_COLLECTION = "mainstats";
const vipCreater = async (steamID, nickname, days, telegramId) => {
  if (!MONGO_URL) {
    console.error("[vipCreater] Не задан MONGO_URL в окружении");
    return;
  }

  const client = new MongoClient(MONGO_URL);

  try {
    await client.connect();
    const db = client.db(DB_NAME);
    const collection = db.collection(DB_COLLECTION);
    const now = new Date();
    const user = await collection.findOne({ _id: steamID });
    let baseDate = now;
    if (user && user.vipEndDate instanceof Date && user.vipEndDate > now) {
      baseDate = user.vipEndDate;
    }

    const newVipEndDate = new Date(
      baseDate.getTime() + days * 24 * 60 * 60 * 1000
    );

    const update = {
      $set: {
        vipEndDate: newVipEndDate,
      },
    };

    if (telegramId) {
      update.$set.telegramid = telegramId.toString();
    }

    await collection.updateOne({ _id: steamID }, update);

    let data;
    try {
      data = fs.readFileSync(ADMINS_CFG_PATH, "utf-8");
    } catch (err) {
      if (err.code === "ENOENT") {
        data = "";
      } else {
        console.error("[vipCreater] Ошибка чтения Admins.cfg:", err);
        return;
      }
    }

    if (!data.match(/\r\n/gm)) {
      data = data.replace(/\n/gm, "\r\n");
    }

    const lines = data.split("\r\n");

    let lastEndIndex = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith("//END")) {
        lastEndIndex = i;
      }
    }
    const playerStartIndex = lastEndIndex >= 0 ? lastEndIndex + 1 : 0;

    let hasReserved = false;

    const newLines = lines.map((line, idx) => {
      if (
        idx >= playerStartIndex &&
        line.startsWith(`Admin=${steamID}:Reserved`)
      ) {
        hasReserved = true;
        return `Admin=${steamID}:Reserved`;
      }
      return line;
    });

    if (!hasReserved) {
      newLines.push(`Admin=${steamID}:Reserved`);
    }

    const newData = newLines.join("\r\n");

    fs.writeFileSync(ADMINS_CFG_PATH, newData);

    const backupName = `AdminsBackup${new Date()
      .toLocaleString("ru-RU", { timeZone: "Europe/Moscow" })
      .replace(/[: ]/g, "_")}.cfg`;
    const backupPath = path.join(ADMINS_CFG_BACKUPS, backupName);
    fs.writeFileSync(backupPath, data);

    if (SYNC_CONFIG_PATH) {
      exec(`${SYNC_CONFIG_PATH}syncconfig.sh`, (err, stdout, stderr) => {
        if (err) {
          console.error("[vipCreater] Ошибка syncconfig.sh:", err);
        } else {
          console.log("[vipCreater] syncconfig.sh stdout:", stdout);
        }
      });
    }

    console.log(
      `[vipCreater] User ${nickname} (${steamID}) VIP продлён/добавлен до ${newVipEndDate.toISOString()}`
    );
  } catch (err) {
    console.error("[vipCreater] Ошибка работы с базой:", err);
  } finally {
    await client.close().catch(() => {});
  }
};

export default vipCreater;
