import { Client, GatewayIntentBits, REST, Routes, AttachmentBuilder } from "discord.js";
import pkg from "@napi-rs/canvas";
const { createCanvas, GlobalFonts, loadImage } = pkg;
import dotenv from "dotenv";
import pg from "pg";
import { google } from "googleapis";

dotenv.config();

const { Pool } = pg;


const db = new Pool({
  host:     process.env.DB_HOST     || "localhost",
  database: process.env.DB_NAME     || "kpidb",
  user:     process.env.DB_USER     || "kpiuser",
  password: process.env.DB_PASS,
  port:     process.env.DB_PORT     || 5432,
});


const SPREADSHEET_ID = "1E0L-mA7qauOfDSnvCprHIV72i31_4HIwDWHvmAr6frw";

async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    scopes: [
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/drive",
    ],
  });
  const authClient = await auth.getClient();
  return google.sheets({ version: "v4", auth: authClient });
}

async function ensureSheet(sheets, title) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const exists = meta.data.sheets.some(s => s.properties.title === title);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title } } }] }
    });
  }
}

async function writeSheet(sheets, title, headers, rows) {
  await ensureSheet(sheets, title);
  const now = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
  const values = [[`更新日時: ${now}`], headers, ...rows];
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${title}!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values }
  });
}


async function initDB() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      userId      TEXT PRIMARY KEY,
      username    TEXT,
      joinDate    TIMESTAMP,
      inviteCode  TEXT,
      inviterId   TEXT,
      inviterName TEXT
    );
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS message_logs (
      id        SERIAL PRIMARY KEY,
      timestamp TIMESTAMP,
      userId    TEXT,
      username  TEXT,
      channelId TEXT,
      messageId TEXT,
      content   TEXT
    );
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS voice_logs (
      id        SERIAL PRIMARY KEY,
      userId    TEXT,
      joinTime  TIMESTAMP,
      leaveTime TIMESTAMP,
      duration  INTEGER
    );
  `);
  for (const col of ["inviteCode  TEXT", "inviterId   TEXT", "inviterName TEXT"]) {
    try { await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ${col}`); } catch (_) {}
  }
  console.log("テーブル確認OK💜");
}


function removeEmoji(str) {
  return str.replace(/[\u{1F000}-\u{1FFFF}|\u{2600}-\u{27FF}|\u{2300}-\u{23FF}|\u{FE00}-\u{FEFF}|\u{1F900}-\u{1F9FF}|\u{1FA00}-\u{1FA9F}]/gu, "")
            .replace(/[^\p{L}\p{N}\p{P}\p{Z}]/gu, "")
            .trim();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

GlobalFonts.registerFromPath("./fonts/LINESeedJP-Regular.ttf", "LINESeed");


const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ]
});


const PIENDOMO_ROLE_ID = "1462591303778046158";
const commands = [
  { name: "piendomo", description: "ぴえんどもロールを付与/解除しますぴえん" }
];


const DISPLAY_NAME_OVERRIDE = {
  "kuri5849": "Disboard",
  ".8luna8": "ディス速",
};


const inviteCache = new Map();

function buildInviteCache(invites) {
  inviteCache.clear();
  invites.forEach(inv => {
    inviteCache.set(inv.code, {
      uses:        inv.uses ?? 0,
      inviterId:   inv.inviter?.id  ?? null,
      inviterName: inv.inviter?.tag ?? null,
    });
  });
}


client.once("ready", async () => {
  console.log(`ログイン成功💜 ${client.user.tag}`);

  await initDB();

  const guild = client.guilds.cache.first();
  if (!guild) return;

  await guild.members.fetch();

  for (const member of guild.members.cache.values()) {
    await db.query(`
      INSERT INTO users (userId, username, joinDate)
      VALUES ($1, $2, $3)
      ON CONFLICT (userId) DO NOTHING
    `, [member.id, member.user.tag, member.joinedAt || new Date()]);
  }

  const invites = await guild.invites.fetch();
  buildInviteCache(invites);
  console.log(`招待キャッシュ構築完了💜 ${inviteCache.size}件`);

  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(client.user.id, guild.id),
    { body: commands }
  );
  console.log("スラッシュコマンド登録完了💜");
});


client.on("guildMemberAdd", async (member) => {
  try {
    const invites = await member.guild.invites.fetch();

    let usedCode    = null;
    let inviterId   = null;
    let inviterName = null;

    invites.forEach(invite => {
      const cached   = inviteCache.get(invite.code);
      const prevUses = cached?.uses ?? 0;
      if ((invite.uses ?? 0) > prevUses) {
        usedCode    = invite.code;
        inviterId   = invite.inviter?.id  ?? null;
        inviterName = invite.inviter?.tag ?? null;
      }
    });

    await db.query(`
      INSERT INTO users (userId, username, joinDate, inviteCode, inviterId, inviterName)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (userId) DO UPDATE SET
        inviteCode  = EXCLUDED.inviteCode,
        inviterId   = EXCLUDED.inviterId,
        inviterName = EXCLUDED.inviterName
    `, [member.id, member.user.tag, new Date(), usedCode, inviterId, inviterName]);

    buildInviteCache(invites);
    console.log(`参加: ${member.user.tag} | 招待コード: ${usedCode ?? "不明"} | 招待者: ${inviterName ?? "不明"}`);
  } catch (err) {
    console.error("guildMemberAdd エラー:", err);
  }
});


const BOOST_CHANNEL_ID = "1478740912875114516";

client.on("guildMemberUpdate", async (oldMember, newMember) => {
  try {
    const wasBooster = oldMember.premiumSince;
    const isBooster  = newMember.premiumSince;
    const channel    = newMember.guild.channels.cache.get(BOOST_CHANNEL_ID);
    if (!channel) return;

    if (!wasBooster && isBooster) {
      await channel.send(`💜 **${newMember.user.tag}** さんがサーバーをブーストしました！\nありがとうございます🎉`);
    }
    if (wasBooster && !isBooster) {
      await channel.send(`💔 **${newMember.user.tag}** さんのブーストが終了しました。`);
    }
  } catch (err) {
    console.error("ブースト検知エラー:", err);
  }
});


client.on("voiceStateUpdate", async (oldState, newState) => {
  try {
    if (!oldState.channelId && newState.channelId) {
      await db.query(`
        INSERT INTO voice_logs (userId, joinTime) VALUES ($1, $2)
      `, [newState.id, new Date()]);
    }
    if (oldState.channelId && !newState.channelId) {
      const result = await db.query(`
        SELECT id, joinTime FROM voice_logs
        WHERE userId = $1 AND leaveTime IS NULL
        ORDER BY id DESC LIMIT 1
      `, [oldState.id]);
      if (result.rows.length === 0) return;
      const row       = result.rows[0];
      const leaveTime = new Date();
      const duration  = Math.floor((leaveTime - new Date(row.jointime)) / 1000);
      await db.query(`
        UPDATE voice_logs SET leaveTime = $1, duration = $2 WHERE id = $3
      `, [leaveTime, duration, row.id]);
    }
  } catch (err) {
    console.error("voiceStateUpdate エラー:", err);
  }
});


client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  if (message.content === "!help") {
    return message.reply(`\
💜 **KPI Bot コマンド一覧**

【発言関連】
\`!7day\`            直近7日の発言ランキング（Top10）
\`!first7\`          参加後7日以内の発言数ランキング（Top10）
\`!retention\`       7日定着率（3発言以上を定着とみなす）

【招待関連】
\`!invite\`          招待コード別 流入人数ランキング
\`!inviteRetention\` 招待コード別 7日定着率レポート

【ランキング画像】
\`!ranking monthly\`  発言ランキングTOP20（月間）画像
\`!ranking total\`    発言ランキングTOP20（累計）画像

【エクスポート】
\`!export\`          全KPIをGoogleスプレッドシートに出力`);
  }


  if (message.content === "!7day") {
    try {
      const result = await db.query(`
        SELECT userId, username, COUNT(*) AS count
        FROM message_logs
        WHERE timestamp >= NOW() - INTERVAL '7 days'
        GROUP BY userId, username
        ORDER BY count DESC
        LIMIT 10
      `);
      if (result.rows.length === 0) return message.reply("💜 直近7日のデータがありません。");
      let text = "💜 **直近7日 発言ランキング**\n\n";
      result.rows.forEach((row, i) => {
        const member      = message.guild.members.cache.get(row.userid);
        const displayName = member?.displayName ?? row.username;
        const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`;
        text += `${medal} ${displayName} ： **${row.count}回**\n`;
      });
      return message.reply(text);
    } catch (err) {
      console.error("!7day エラー:", err);
      return message.reply("エラーが発生しました💜");
    }
  }


  if (message.content === "!first7") {
    try {
      const result = await db.query(`
        SELECT u.userId, u.username, COUNT(m.id) AS count
        FROM users u
        LEFT JOIN message_logs m
          ON u.userId = m.userId
         AND m.timestamp BETWEEN u.joinDate AND u.joinDate + INTERVAL '7 days'
        GROUP BY u.userId, u.username
        ORDER BY count DESC
        LIMIT 10
      `);
      if (result.rows.length === 0) return message.reply("💜 データがありません。");
      let text = "💜 **参加後7日以内 発言数ランキング**\n\n";
      result.rows.forEach((row, i) => {
        const member      = message.guild.members.cache.get(row.userid);
        const displayName = member?.displayName ?? row.username;
        const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`;
        text += `${medal} ${displayName} ： **${row.count}回**\n`;
      });
      return message.reply(text);
    } catch (err) {
      console.error("!first7 エラー:", err);
      return message.reply("エラーが発生しました💜");
    }
  }

 
  if (message.content === "!retention") {
    try {
      const result = await db.query(`
        SELECT u.userId, COUNT(m.id) AS count
        FROM users u
        LEFT JOIN message_logs m
          ON u.userId = m.userId
         AND m.timestamp BETWEEN u.joinDate AND u.joinDate + INTERVAL '7 days'
        GROUP BY u.userId
      `);
      const total    = result.rows.length;
      const retained = result.rows.filter(r => r.count >= 3).length;
      const rate     = total === 0 ? "0.0" : ((retained / total) * 100).toFixed(1);
      return message.reply(
`💜 **7日定着率レポート**

対象人数　　　: ${total}人
定着（3発言以上）: ${retained}人
定着率　　　　: **${rate}%**`
      );
    } catch (err) {
      console.error("!retention エラー:", err);
      return message.reply("エラーが発生しました💜");
    }
  }


  if (message.content === "!invite") {
    try {
      const result = await db.query(`
        SELECT inviteCode, MAX(inviterName) AS inviterName, MAX(inviterId) AS inviterId, COUNT(*) AS count
        FROM users
        WHERE inviteCode IS NOT NULL
        GROUP BY inviteCode
        ORDER BY count DESC
        LIMIT 10
      `);
      if (result.rows.length === 0) return message.reply("💜 招待データがありません。");

      let text = "💜 **招待コード別 流入人数**\n\n";
      let rank = 1;
      for (const row of result.rows) {
        let member = row.inviterid ? message.guild.members.cache.get(row.inviterid) : null;
        if (!member && row.inviterid) {
          try { member = await message.guild.members.fetch(row.inviterid); } catch (_) {}
        }
        const code      = row.invitecode ?? "不明";
        const _username1 = member?.user.username ?? row.invitername;
        const inviter   = DISPLAY_NAME_OVERRIDE[_username1] ?? member?.user.username ?? member?.displayName ?? row.invitername ?? "不明";
        const inviterId = row.inviterid ?? "不明";
        text += `${rank++}. **${inviter}** (\`${inviterId}\`)　\`${code}\`　→ **${row.count}人**\n`;
      }

      return message.reply(text);
    } catch (err) {
      console.error("!invite エラー:", err);
      return message.reply("エラーが発生しました💜");
    }
  }

 
  if (message.content === "!inviteRetention") {
    try {
      const result = await db.query(`
        SELECT
          inviteCode, inviterId, inviterName,
          COUNT(*) AS total,
          SUM(CASE WHEN first7_count >= 3 THEN 1 ELSE 0 END) AS retained
        FROM (
          SELECT u.userId, u.inviteCode, u.inviterId, u.inviterName, COUNT(m.id) AS first7_count
          FROM users u
          LEFT JOIN message_logs m
            ON u.userId = m.userId
           AND m.timestamp BETWEEN u.joinDate AND u.joinDate + INTERVAL '7 days'
          GROUP BY u.userId, u.inviteCode, u.inviterId, u.inviterName
        ) sub
        WHERE inviteCode IS NOT NULL
        GROUP BY inviteCode, inviterId, inviterName
        ORDER BY total DESC
      `);
      if (result.rows.length === 0) return message.reply("💜 招待データがありません。");

      let text = "💜 **招待コード別 7日定着率レポート**\n\n";
      let displayed = 0;
      for (const row of result.rows) {
        if (displayed >= 10) break;
        let member = row.inviterid ? message.guild.members.cache.get(row.inviterid) : null;
        if (!member && row.inviterid) {
          try { member = await message.guild.members.fetch(row.inviterid); } catch (_) {}
        }
        const code      = row.invitecode;
        const _username2 = member?.user.username ?? row.invitername;
        const inviter   = DISPLAY_NAME_OVERRIDE[_username2] ?? member?.user.username ?? member?.displayName ?? row.invitername ?? "退鯖済み";
        const inviterId = row.inviterid ?? "不明";
        const retained  = Number(row.retained) || 0;
        const total     = Number(row.total)    || 0;
        const rate      = total === 0 ? "0.0" : ((retained / total) * 100).toFixed(1);
        const emoji     = rate >= 70 ? "🟢" : rate >= 40 ? "🟡" : "🔴";
        text += `${emoji} \`${code}\`　招待者: **${inviter}** (\`${inviterId}\`)\n　流入: ${total}人　定着: ${retained}人　定着率: **${rate}%**\n\n`;
        displayed++;
      }
      return message.reply(text);
    } catch (err) {
      console.error("!inviteRetention エラー:", err);
      return message.reply("エラーが発生しました💜");
    }
  }


  if (message.content === "!export") {
    try {
      await message.channel.send("💜 Googleスプレッドシートに出力中...");
      const sheets = await getSheetsClient();

      const r7day = await db.query(`
        SELECT username, COUNT(*) AS count
        FROM message_logs
        WHERE timestamp >= NOW() - INTERVAL '7 days'
        GROUP BY userId, username ORDER BY count DESC LIMIT 10
      `);
      await writeSheet(sheets, "直近7日発言ランキング",
        ["順位", "ユーザー名", "発言数"],
        r7day.rows.map((r, i) => [i + 1, r.username, r.count])
      );

      const rfirst7 = await db.query(`
        SELECT u.username, COUNT(m.id) AS count
        FROM users u
        LEFT JOIN message_logs m ON u.userId = m.userId
          AND m.timestamp BETWEEN u.joinDate AND u.joinDate + INTERVAL '7 days'
        GROUP BY u.userId, u.username ORDER BY count DESC LIMIT 10
      `);
      await writeSheet(sheets, "参加後7日発言数",
        ["順位", "ユーザー名", "発言数"],
        rfirst7.rows.map((r, i) => [i + 1, r.username, r.count])
      );

      const rretention = await db.query(`
        SELECT u.userId, COUNT(m.id) AS count
        FROM users u
        LEFT JOIN message_logs m ON u.userId = m.userId
          AND m.timestamp BETWEEN u.joinDate AND u.joinDate + INTERVAL '7 days'
        GROUP BY u.userId
      `);
      const total    = rretention.rows.length;
      const retained = rretention.rows.filter(r => r.count >= 3).length;
      const rate     = total === 0 ? "0.0" : ((retained / total) * 100).toFixed(1);
      await writeSheet(sheets, "7日定着率",
        ["対象人数", "定着人数", "定着率(%)"],
        [[total, retained, rate]]
      );

      const rinvite = await db.query(`
        SELECT inviteCode, inviterName, COUNT(*) AS count
        FROM users WHERE inviteCode IS NOT NULL GROUP BY inviteCode, inviterName ORDER BY count DESC
      `);
      await writeSheet(sheets, "招待別流入数",
        ["招待コード", "招待者", "流入人数"],
        rinvite.rows.map(r => [r.invitecode ?? "不明", r.invitername ?? "不明", r.count])
      );

      const rinviteRet = await db.query(`
        SELECT inviteCode, inviterName,
          COUNT(*) AS total,
          SUM(CASE WHEN first7_count >= 3 THEN 1 ELSE 0 END) AS retained
        FROM (
          SELECT u.userId, u.inviteCode, u.inviterName, COUNT(m.id) AS first7_count
          FROM users u
          LEFT JOIN message_logs m ON u.userId = m.userId
            AND m.timestamp BETWEEN u.joinDate AND u.joinDate + INTERVAL '7 days'
          GROUP BY u.userId, u.inviteCode, u.inviterName
        ) sub
        WHERE inviteCode IS NOT NULL
        GROUP BY inviteCode, inviterName ORDER BY total DESC
      `);
      await writeSheet(sheets, "招待別定着率",
        ["招待コード", "招待者", "流入人数", "定着人数", "定着率(%)"],
        rinviteRet.rows.map(r => {
          const ret = Number(r.retained) || 0;
          const tot = Number(r.total)    || 0;
          const rt  = tot === 0 ? "0.0" : ((ret / tot) * 100).toFixed(1);
          return [r.invitecode ?? "不明", r.invitername ?? "不明", tot, ret, rt];
        })
      );

      return message.reply("✅ スプレッドシートへの出力が完了しました💜\nhttps://docs.google.com/spreadsheets/d/1E0L-mA7qauOfDSnvCprHIV72i31_4HIwDWHvmAr6frw/edit");
    } catch (err) {
      console.error("!export エラー:", err);
      return message.reply(`エラーが発生しました💜\n\`\`\`${err.message}\`\`\``);
    }
  }

 
  if (message.content === "!ranking monthly" || message.content === "!ranking total") {
    try {
      const isMonthly = message.content === "!ranking monthly";
      const title     = isMonthly ? "発言ランキングTOP20（月間）" : "発言ランキングTOP20（累計）";
      const guild     = message.guild;
      const bans      = await guild.bans.fetch();
      const bannedIds = new Set(bans.map(ban => ban.user.id));

      const result = await db.query(
        isMonthly
          ? `SELECT userId, username, COUNT(*) AS count FROM message_logs
             WHERE timestamp >= date_trunc('month', NOW())
             GROUP BY userId, username ORDER BY count DESC LIMIT 20`
          : `SELECT userId, username, COUNT(*) AS count FROM message_logs
             GROUP BY userId, username ORDER BY count DESC LIMIT 20`
      );

      let rows = result.rows.filter(row => !bannedIds.has(row.userid));
      if (rows.length === 0) return message.reply("💜 データがありません。");

      rows = rows.map(row => {
        const member      = guild.members.cache.get(row.userid);
        const displayName = member?.displayName ?? row.username;
        const avatarURL   = member?.user.displayAvatarURL({ extension: "png", size: 64 }) ?? null;
        return { ...row, username: displayName, avatarURL };
      });

      const W = 1080;
      const H = 100 + Math.ceil(rows.length / 2) * (90 + 16) + 20;
      const canvas = createCanvas(W, H);
      const ctx    = canvas.getContext("2d");

      ctx.fillStyle = "#fdf0f5";
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = "#f7a8c4";
      ctx.fillRect(0, 0, W, 80);
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 34px LINESeed";
      ctx.fillText(title, 24, 52);

      const now = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
      ctx.font = "22px LINESeed";
      ctx.textAlign = "right";
      ctx.fillText(`更新 ${now} JST`, W - 20, 52);
      ctx.textAlign = "left";

      const cardW = 500, cardH = 90, paddingX = 20, paddingY = 100, gapX = 20, gapY = 16;
      const half  = Math.ceil(rows.length / 2);

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const col = i < half ? 0 : 1;
        const r   = i < half ? i : i - half;
        const x   = paddingX + col * (cardW + gapX);
        const y   = paddingY + r * (cardH + gapY);

        ctx.fillStyle = "#ffffff";
        roundRect(ctx, x, y, cardW, cardH, 16);
        ctx.fill();

        const avatarSize = 52;
        const avatarX    = x + 48;
        const avatarY    = y + (cardH - avatarSize) / 2;
        if (row.avatarURL) {
          try {
            const img = await loadImage(row.avatarURL);
            ctx.save();
            ctx.beginPath();
            ctx.arc(avatarX + avatarSize / 2, avatarY + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2);
            ctx.closePath();
            ctx.clip();
            ctx.drawImage(img, avatarX, avatarY, avatarSize, avatarSize);
            ctx.restore();
          } catch (_) {}
        }

        ctx.font = "bold 26px LINESeed";
        ctx.fillStyle = i === 0 ? "#e8a0bf" : i === 1 ? "#b0b0b0" : i === 2 ? "#c8a96e" : "#888888";
        ctx.fillText(String(i + 1), x + 14, y + 38);

        ctx.font = "bold 24px LINESeed";
        ctx.fillStyle = "#333333";
        const cleanName = removeEmoji(row.username) || row.username;
        const name = cleanName.length > 12 ? cleanName.slice(0, 12) + "…" : cleanName;
        ctx.fillText(name, x + 110, y + 38);

        ctx.font = "bold 20px LINESeed";
        ctx.fillStyle = "#f7a8c4";
        ctx.textAlign = "right";
        ctx.fillText(`${row.count}回`, x + cardW - 16, y + 38);
        ctx.textAlign = "left";

        const maxCount = Number(rows[0].count);
        const barW = cardW - 120, barX = x + 110, barY = y + 58;
        ctx.fillStyle = "#f0f0f0";
        roundRect(ctx, barX, barY, barW, 10, 5);
        ctx.fill();
        const progress = Math.max(Number(row.count) / maxCount, 0.02);
        ctx.fillStyle = "#f7a8c4";
        roundRect(ctx, barX, barY, barW * progress, 10, 5);
        ctx.fill();
      }

      const buffer     = canvas.toBuffer("image/png");
      const attachment = new AttachmentBuilder(buffer, { name: "ranking.png" });
      return message.reply({ files: [attachment] });
    } catch (err) {
      console.error("!ranking エラー:", err);
      return message.reply("エラーが発生しました💜");
    }
  }

  
  try {
    await db.query(`
      INSERT INTO message_logs (timestamp, userId, username, channelId, messageId, content)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [new Date(), message.author.id, message.author.tag, message.channel.id, message.id, message.content]);
  } catch (err) {
    console.error("メッセージ保存エラー:", err);
  }
});


client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "piendomo") {
    try {
      const member = interaction.member;
      const role   = interaction.guild.roles.cache.get(PIENDOMO_ROLE_ID);

      if (!role) {
        return interaction.reply({ content: "💜 ロールが見つかりません", ephemeral: true });
      }

      if (member.roles.cache.has(PIENDOMO_ROLE_ID)) {
        await member.roles.remove(role);
        return interaction.reply({
          content: `💜 **${member.user.tag}** さんの @ぴえんども ロールを解除しました！`,
          ephemeral: false
        });
      } else {
        await member.roles.add(role);
        return interaction.reply({
          content: `💜 **${member.user.tag}** さんに @ぴえんども ロールを付与しました！`,
          ephemeral: false
        });
      }
    } catch (err) {
      console.error("piendomoエラー:", err);
      return interaction.reply({ content: "エラーが発生しました💜", ephemeral: true });
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
