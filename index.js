import { Client, GatewayIntentBits } from "discord.js";
import dotenv from "dotenv";
import pg from "pg";
import 'dotenv/config'

console.log(process.env.DATABASE_URL)

dotenv.config();
const { Pool } = pg;

/* ===============================
   💜 PostgreSQL 接続
================================ */
const db = new Pool({
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  port: process.env.DB_PORT,
  ssl: { rejectUnauthorized: false }
});

/* ===============================
   💜 テーブル作成
================================ */
async function initDB() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      userId TEXT PRIMARY KEY,
      username TEXT,
      joinDate TIMESTAMP,
      inviteCode TEXT
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS message_logs (
      id SERIAL PRIMARY KEY,
      timestamp TIMESTAMP,
      userId TEXT,
      username TEXT,
      channelId TEXT,
      messageId TEXT,
      content TEXT
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS voice_logs (
      id SERIAL PRIMARY KEY,
      userId TEXT,
      joinTime TIMESTAMP,
      leaveTime TIMESTAMP,
      duration INTEGER
    );
  `);

  console.log("テーブル確認OK💜");
}

/* ===============================
   💜 Discord Client
================================ */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates
  ]
});

/* ===============================
   💜 招待キャッシュ
================================ */
const inviteCache = new Map();

/* ===============================
   💜 起動時処理
================================ */
client.once("clientReady", async () => {
  console.log(`ログイン成功💜 ${client.user.tag}`);

  await initDB();

  const guild = client.guilds.cache.first();
  if (!guild) return;

  await guild.members.fetch();

  for (const member of guild.members.cache.values()) {
    await db.query(
      `INSERT INTO users (userId, username, joinDate)
       VALUES ($1, $2, $3)
       ON CONFLICT (userId) DO NOTHING`,
      [member.id, member.user.tag, member.joinedAt || new Date()]
    );
  }

  const invites = await guild.invites.fetch();
  invites.forEach(inv => inviteCache.set(inv.code, inv.uses));
});

/* ===============================
   💜 新規参加
================================ */
client.on("guildMemberAdd", async (member) => {
  const invites = await member.guild.invites.fetch();
  let usedInvite = null;

  invites.forEach(invite => {
    const prev = inviteCache.get(invite.code) || 0;
    if (invite.uses > prev) usedInvite = invite.code;
  });

  await db.query(
    `INSERT INTO users (userId, username, joinDate, inviteCode)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (userId)
     DO UPDATE SET inviteCode = $4`,
    [member.id, member.user.tag, new Date(), usedInvite]
  );

  inviteCache.clear();
  invites.forEach(inv => inviteCache.set(inv.code, inv.uses));
});

/* ===============================
   💜 VCログ
================================ */
client.on("voiceStateUpdate", async (oldState, newState) => {

  // 入室
  if (!oldState.channelId && newState.channelId) {
    await db.query(
      `INSERT INTO voice_logs (userId, joinTime)
       VALUES ($1, $2)`,
      [newState.id, new Date()]
    );
  }

  // 退室
  if (oldState.channelId && !newState.channelId) {
    const result = await db.query(
      `SELECT id, joinTime FROM voice_logs
       WHERE userId = $1
       ORDER BY id DESC LIMIT 1`,
      [oldState.id]
    );

    if (result.rows.length === 0) return;

    const row = result.rows[0];
    const leaveTime = new Date();
    const duration =
      Math.floor((leaveTime - new Date(row.jointime)) / 1000);

    await db.query(
      `UPDATE voice_logs
       SET leaveTime = $1, duration = $2
       WHERE id = $3`,
      [leaveTime, duration, row.id]
    );
  }
});

/* ===============================
   💜 コマンド処理
================================ */
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  // ヘルプ
  if (message.content === "!help") {
    return message.reply(`
💜 **KPI Bot コマンド一覧**

【発言関連】
!7day
!first7
!retention

【招待関連】
!invite
!inviteRetention
`);
  }

  /* ===== 7日ランキング ===== */
  if (message.content === "!7day") {
    const result = await db.query(`
      SELECT username, COUNT(*) as count
      FROM message_logs
      WHERE timestamp >= NOW() - INTERVAL '7 days'
      GROUP BY userId, username
      ORDER BY count DESC
      LIMIT 10
    `);

    let text = "💜直近7日発言ランキング\n\n";
    result.rows.forEach((row, i) => {
      text += `${i + 1}. ${row.username} : ${row.count}回\n`;
    });

    return message.reply(text || "データなし💜");
  }

  /* ===== 参加後7日 ===== */
  if (message.content === "!first7") {
    const result = await db.query(`
      SELECT u.username, COUNT(m.id) as count
      FROM users u
      LEFT JOIN message_logs m
        ON u.userId = m.userId
        AND m.timestamp BETWEEN u.joinDate
        AND u.joinDate + INTERVAL '7 days'
      GROUP BY u.userId, u.username
      ORDER BY count DESC
      LIMIT 10
    `);

    let text = "💜参加後7日以内発言数\n\n";
    result.rows.forEach((row, i) => {
      text += `${i + 1}. ${row.username} : ${row.count}回\n`;
    });

    return message.reply(text);
  }

  /* ===== 定着率 ===== */
  if (message.content === "!retention") {
    const result = await db.query(`
      SELECT u.userId,
             COUNT(m.id) as count
      FROM users u
      LEFT JOIN message_logs m
        ON u.userId = m.userId
        AND m.timestamp BETWEEN u.joinDate
        AND u.joinDate + INTERVAL '7 days'
      GROUP BY u.userId
    `);

    const total = result.rows.length;
    const retained =
      result.rows.filter(r => r.count >= 3).length;

    const rate =
      total === 0 ? 0 :
      ((retained / total) * 100).toFixed(1);

    return message.reply(
`💜7日定着率

対象: ${total}人
定着(3発言以上): ${retained}人
定着率: ${rate}%`
    );
  }

  /* ===== 招待別流入 ===== */
  if (message.content === "!invite") {
    const result = await db.query(`
      SELECT inviteCode,
             COUNT(*) as count
      FROM users
      GROUP BY inviteCode
      ORDER BY count DESC
    `);

    let text = "💜招待リンク別流入数\n\n";

    result.rows.forEach(row => {
      text += `${row.invitecode || "不明"} : ${row.count}人\n`;
    });

    return message.reply(text);
  }

  /* ===== 招待別定着率 ===== */
  if (message.content === "!inviteRetention") {
    const result = await db.query(`
      SELECT inviteCode,
             COUNT(*) as total,
             SUM(CASE WHEN first7_count >= 3 THEN 1 ELSE 0 END) as retained
      FROM (
        SELECT u.userId,
               u.inviteCode,
               COUNT(m.id) as first7_count
        FROM users u
        LEFT JOIN message_logs m
          ON u.userId = m.userId
          AND m.timestamp BETWEEN u.joinDate
          AND u.joinDate + INTERVAL '7 days'
        GROUP BY u.userId
      ) sub
      GROUP BY inviteCode
      ORDER BY total DESC
    `);

    let text = "💜招待リンク別7日定着率\n\n";

    result.rows.forEach(row => {
      const rate =
        row.total === 0 ? 0 :
        ((row.retained / row.total) * 100).toFixed(1);

      text += `${row.invitecode || "不明"}
流入: ${row.total}人
定着: ${row.retained}人
定着率: ${rate}%\n\n`;
    });

    return message.reply(text);
  }

  /* ===== 通常メッセージ保存 ===== */
  await db.query(
    `INSERT INTO message_logs
     (timestamp, userId, username, channelId, messageId, content)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      new Date(),
      message.author.id,
      message.author.tag,
      message.channel.id,
      message.id,
      message.content
    ]
  );
});

/* ===============================
   💜 ログイン
================================ */
client.login(process.env.DISCORD_TOKEN);