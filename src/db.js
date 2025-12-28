const mysql = require('mysql2/promise');

const MYSQL_HOST = process.env.MYSQL_HOST || '127.0.0.1';
const MYSQL_PORT = process.env.MYSQL_PORT || 3306;
const MYSQL_USER = process.env.MYSQL_USER || 'root';
const MYSQL_PASSWORD = process.env.MYSQL_PASSWORD || '';
const MYSQL_DATABASE = process.env.MYSQL_DATABASE || 'minechat';

let pool;

async function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: MYSQL_HOST,
      port: MYSQL_PORT,
      user: MYSQL_USER,
      password: MYSQL_PASSWORD,
      database: MYSQL_DATABASE,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      decimalNumbers: true
    });
  }
  return pool;
}

async function init() {
  const p = await getPool();
  // Create database schema if not exists
  // Note: assumes user has permission to CREATE TABLE in the database
  await p.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(48) PRIMARY KEY,
      ms_id VARCHAR(255) UNIQUE,
      username VARCHAR(191),
      minecraft_id VARCHAR(255),
      face_key VARCHAR(512),
      created_at DATETIME
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // Backward-compatible migration for older databases
  try {
    await p.execute('ALTER TABLE users ADD COLUMN face_key VARCHAR(512) NULL');
  } catch (e) {
    // ignore if column already exists
  }

  await p.execute(`
    CREATE TABLE IF NOT EXISTS chats (
      id VARCHAR(48) PRIMARY KEY,
      type VARCHAR(32),
      name VARCHAR(255),
      created_by VARCHAR(48),
      created_at DATETIME,
      INDEX (created_by)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await p.execute(`
    CREATE TABLE IF NOT EXISTS chat_members (
      chat_id VARCHAR(48),
      user_id VARCHAR(48),
      PRIMARY KEY (chat_id, user_id),
      INDEX (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

    updateUserFaceKey,
  await p.execute(`
    CREATE TABLE IF NOT EXISTS messages (
      id VARCHAR(48) PRIMARY KEY,
      chat_id VARCHAR(48),
      from_user VARCHAR(48),
      type VARCHAR(32),
      content JSON,
      replied_to VARCHAR(48),
      created_at DATETIME,
      deleted_at DATETIME,
      INDEX (chat_id),
      INDEX (from_user)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await p.execute(`
    CREATE TABLE IF NOT EXISTS global_messages (
      id VARCHAR(48) PRIMARY KEY,
      from_user VARCHAR(48),
      type VARCHAR(32),
      content JSON,
      created_at DATETIME,
      INDEX (from_user),
      INDEX (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  
  await p.execute(`
    CREATE TABLE IF NOT EXISTS message_read (
      message_id VARCHAR(48),
      user_id VARCHAR(48),
      PRIMARY KEY (message_id, user_id),
      INDEX (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await p.execute(`
    CREATE TABLE IF NOT EXISTS sessions (
      id VARCHAR(128) PRIMARY KEY,
      user_id VARCHAR(48),
      expires_at DATETIME,
      created_at DATETIME,
      INDEX (user_id),
      INDEX (expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await p.execute(`
    CREATE TABLE IF NOT EXISTS emoji_packs (
      id VARCHAR(48) PRIMARY KEY,
      user_id VARCHAR(48),
      name VARCHAR(255),
      object_key VARCHAR(512),
      meta JSON,
      created_at DATETIME,
      INDEX (user_id),
      INDEX (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await p.execute(`
    CREATE TABLE IF NOT EXISTS media (
      id VARCHAR(48) PRIMARY KEY,
      owner_id VARCHAR(48),
      type VARCHAR(64),
      original_name VARCHAR(255),
      object_key VARCHAR(512),
      thumb_key VARCHAR(512),
      meta JSON,
      created_at DATETIME,
      INDEX (owner_id),
      INDEX (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
}

// User helpers
async function findUserByMsId(msId) {
  const p = await getPool();
  const [rows] = await p.execute('SELECT * FROM users WHERE ms_id = ? LIMIT 1', [msId]);
  return rows[0];
}

async function findUserByMinecraftId(minecraftId) {
  const p = await getPool();
  const [rows] = await p.execute('SELECT * FROM users WHERE minecraft_id = ? LIMIT 1', [minecraftId]);
  return rows[0];
}

async function findUserById(id) {
  const p = await getPool();
  const [rows] = await p.execute('SELECT * FROM users WHERE id = ? LIMIT 1', [id]);
  return rows[0];
}

async function createUser({ id, msId, username, minecraftId }) {
  const p = await getPool();
  const createdAt = new Date();
  await p.execute('INSERT INTO users (id, ms_id, username, minecraft_id, face_key, created_at) VALUES (?, ?, ?, ?, ?, ?)', [id, msId, username, minecraftId, null, createdAt]);
  return findUserById(id);
}

async function updateUsername(id, username) {
  const p = await getPool();
  await p.execute('UPDATE users SET username = ? WHERE id = ?', [username, id]);
}

async function updateUserFaceKey(id, faceKey) {
  const p = await getPool();
  await p.execute('UPDATE users SET face_key = ? WHERE id = ?', [faceKey, id]);
}

// Chat helpers
async function createChat({ id, type, name, members, createdBy }) {
  const p = await getPool();
  const createdAt = new Date();
  await p.execute('INSERT INTO chats (id, type, name, created_by, created_at) VALUES (?, ?, ?, ?, ?)', [id, type, name, createdBy, createdAt]);
  // insert members
  const memberInserts = members.map(m => p.execute('INSERT IGNORE INTO chat_members (chat_id, user_id) VALUES (?, ?)', [id, m]));
  await Promise.all(memberInserts);
  return getChatById(id);
}

async function getChatById(id) {
  const p = await getPool();
  const [rows] = await p.execute('SELECT * FROM chats WHERE id = ? LIMIT 1', [id]);
  const chat = rows[0];
  if (!chat) return null;
  const [members] = await p.execute('SELECT user_id FROM chat_members WHERE chat_id = ?', [id]);
  chat.members = members.map(r => r.user_id);
  return chat;
}

async function getChatsForUser(userId) {
  const p = await getPool();
  const [rows] = await p.execute(
    `SELECT c.* FROM chats c JOIN chat_members m ON c.id = m.chat_id WHERE m.user_id = ?`,
    [userId]
  );
  const chats = [];
  for (const c of rows) {
    const [members] = await p.execute('SELECT user_id FROM chat_members WHERE chat_id = ?', [c.id]);
    c.members = members.map(r => r.user_id);
    
    // Get the latest message for this chat
    const [latestMsg] = await p.execute(
      'SELECT * FROM messages WHERE chat_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1',
      [c.id]
    );
    if (latestMsg.length > 0) {
      const msg = latestMsg[0];
      try {
        msg.content = typeof msg.content === 'string' ? JSON.parse(msg.content) : (msg.content || null);
      } catch {
        msg.content = msg.content || null;
      }
      c.lastMessage = msg;
    } else {
      c.lastMessage = null;
    }
    
    chats.push(c);
  }
  return chats;
}

async function getAllUsers() {
  const p = await getPool();
  const [rows] = await p.execute('SELECT id, username, face_key FROM users');
  return rows;
}

// Emoji pack helpers
async function createEmojiPack({ id, userId, name, key, meta }) {
  const p = await getPool();
  const createdAt = new Date();
  const metaJson = JSON.stringify(meta === undefined ? null : meta);
  await p.execute('INSERT INTO emoji_packs (id, user_id, name, object_key, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)', [id, userId, name, key, metaJson, createdAt]);
  const [rows] = await p.execute('SELECT id, user_id, name, object_key AS `key`, meta, created_at FROM emoji_packs WHERE id = ? LIMIT 1', [id]);
  const r = rows[0];
  if (!r) return null;
  try { r.meta = typeof r.meta === 'string' ? JSON.parse(r.meta) : (r.meta || null); } catch { r.meta = r.meta || null; }
  return r;
}

async function getEmojiPacksForUser(userId) {
  const p = await getPool();
  const [rows] = await p.execute('SELECT id, user_id, name, object_key AS `key`, meta, created_at FROM emoji_packs WHERE user_id = ? ORDER BY created_at DESC', [userId]);
  for (const r of rows) {
    try { r.meta = typeof r.meta === 'string' ? JSON.parse(r.meta) : (r.meta || null); } catch { r.meta = r.meta || null; }
  }
  return rows;
}

async function findEmojiPackById(id) {
  const p = await getPool();
  const [rows] = await p.execute('SELECT id, user_id, name, object_key AS `key`, meta, created_at FROM emoji_packs WHERE id = ? LIMIT 1', [id]);
  const r = rows[0];
  if (!r) return null;
  try { r.meta = typeof r.meta === 'string' ? JSON.parse(r.meta) : (r.meta || null); } catch { r.meta = r.meta || null; }
  return r;
}

// Media helpers
async function createMedia({ id, ownerId, type, originalName, objectKey, thumbKey, meta }) {
  const p = await getPool();
  const createdAt = new Date();
  const metaJson = JSON.stringify(meta === undefined ? null : meta);
  await p.execute('INSERT INTO media (id, owner_id, type, original_name, object_key, thumb_key, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [id, ownerId, type, originalName, objectKey, thumbKey || null, metaJson, createdAt]);
  const [rows] = await p.execute('SELECT id, owner_id, type, original_name, object_key AS `key`, thumb_key AS thumbKey, meta, created_at FROM media WHERE id = ? LIMIT 1', [id]);
  const r = rows[0];
  if (!r) return null;
  try { r.meta = typeof r.meta === 'string' ? JSON.parse(r.meta) : (r.meta || null); } catch { r.meta = r.meta || null; }
  return r;
}

async function findMediaById(id) {
  const p = await getPool();
  const [rows] = await p.execute('SELECT id, owner_id, type, original_name, object_key AS `key`, thumb_key AS thumbKey, meta, created_at FROM media WHERE id = ? LIMIT 1', [id]);
  const r = rows[0];
  if (!r) return null;
  try { r.meta = typeof r.meta === 'string' ? JSON.parse(r.meta) : (r.meta || null); } catch { r.meta = r.meta || null; }
  return r;
}

async function getMediaForOwner(ownerId) {
  const p = await getPool();
  const [rows] = await p.execute('SELECT id, owner_id, type, original_name, object_key AS `key`, thumb_key AS thumbKey, meta, created_at FROM media WHERE owner_id = ? ORDER BY created_at DESC', [ownerId]);
  for (const r of rows) {
    try { r.meta = typeof r.meta === 'string' ? JSON.parse(r.meta) : (r.meta || null); } catch { r.meta = r.meta || null; }
  }
  return rows;
}

// Global chat helpers
async function createGlobalMessage({ id, from, type = 'text', content }) {
  const p = await getPool();
  const createdAt = new Date();
  const contentJson = JSON.stringify(content === undefined ? null : content);
  await p.execute('INSERT INTO global_messages (id, from_user, type, content, created_at) VALUES (?, ?, ?, ?, ?)', [id, from, type, contentJson, createdAt]);
  return findGlobalMessageById(id);
}

async function findGlobalMessageById(id) {
  const p = await getPool();
  const [rows] = await p.execute('SELECT * FROM global_messages WHERE id = ? LIMIT 1', [id]);
  const msg = rows[0];
  if (!msg) return null;
  try { msg.content = typeof msg.content === 'string' ? JSON.parse(msg.content) : (msg.content || null); } catch { msg.content = msg.content || null; }
  return msg;
}

async function getLatestGlobalMessages(limit = 50) {
  const p = await getPool();
  const l = Math.max(1, Math.min(1000, Number(limit) || 50));
  const [rows] = await p.execute(`SELECT * FROM global_messages ORDER BY created_at DESC, id DESC LIMIT ${l}`);
  for (const r of rows) {
    try { r.content = typeof r.content === 'string' ? JSON.parse(r.content) : (r.content || null); } catch { r.content = r.content || null; }
  }
  return rows.reverse();
}

async function getGlobalMessagesBefore(beforeMessageId, limit = 50) {
  const p = await getPool();
  const [beforeRows] = await p.execute('SELECT created_at FROM global_messages WHERE id = ? LIMIT 1', [beforeMessageId]);
  if (!beforeRows || beforeRows.length === 0) return [];
  const cutoff = beforeRows[0].created_at;
  const l = Math.max(1, Math.min(1000, Number(limit) || 50));
  const [rows] = await p.execute(`SELECT * FROM global_messages WHERE (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ${l}`, [cutoff, cutoff, beforeMessageId]);
  for (const r of rows) {
    try { r.content = typeof r.content === 'string' ? JSON.parse(r.content) : (r.content || null); } catch { r.content = r.content || null; }
  }
  return rows.reverse();
}

async function getGlobalMessagesSince(since) {
  const p = await getPool();
  const [rows] = await p.execute('SELECT * FROM global_messages WHERE created_at > ? ORDER BY created_at ASC', [since]);
  for (const r of rows) {
    try { r.content = typeof r.content === 'string' ? JSON.parse(r.content) : (r.content || null); } catch { r.content = r.content || null; }
  }
  return rows;
}

async function findSingleChatBetween(userA, userB) {
  const p = await getPool();
  const [rows] = await p.execute(
    `SELECT c.* FROM chats c
      WHERE c.type = 'single' AND
        EXISTS (SELECT 1 FROM chat_members m WHERE m.chat_id = c.id AND m.user_id = ?)
        AND EXISTS (SELECT 1 FROM chat_members m2 WHERE m2.chat_id = c.id AND m2.user_id = ?)
      LIMIT 1`,
    [userA, userB]
  );
  const chat = rows[0];
  if (!chat) return null;
  const [members] = await p.execute('SELECT user_id FROM chat_members WHERE chat_id = ?', [chat.id]);
  chat.members = members.map(r => r.user_id);
  return chat;
}

async function findSelfChatForUser(userId) {
  const p = await getPool();

  // Find ALL self-chats first so we can deduplicate here.
  const [rows] = await p.execute(
    `SELECT c.id FROM chats c
      WHERE c.type = 'single'
        AND EXISTS (SELECT 1 FROM chat_members m WHERE m.chat_id = c.id AND m.user_id = ?)
        AND (SELECT COUNT(*) FROM chat_members m2 WHERE m2.chat_id = c.id) = 1
      ORDER BY c.created_at ASC, c.id ASC`,
    [userId]
  );

  if (!rows || rows.length === 0) return null;
  const keepId = rows[0].id;

  // If there are duplicates, migrate messages into the kept chat and remove extras.
  if (rows.length > 1) {
    const dupIds = rows.slice(1).map(r => r.id);
    const conn = await p.getConnection();
    try {
      await conn.beginTransaction();
      for (const dupId of dupIds) {
        // Move messages over so no history is lost.
        await conn.execute('UPDATE messages SET chat_id = ? WHERE chat_id = ?', [keepId, dupId]);

        // Ensure membership exists on kept chat (safe no-op due to PK).
        await conn.execute('INSERT IGNORE INTO chat_members (chat_id, user_id) SELECT ?, user_id FROM chat_members WHERE chat_id = ?', [keepId, dupId]);

        // Remove duplicate chat + members.
        await conn.execute('DELETE FROM chat_members WHERE chat_id = ?', [dupId]);
        await conn.execute('DELETE FROM chats WHERE id = ?', [dupId]);
      }
      await conn.commit();
    } catch (e) {
      try { await conn.rollback(); } catch (e2) { }
      // If cleanup fails, we still return a valid self chat.
      console.warn('self-chat dedupe failed', e?.message || e);
    } finally {
      conn.release();
    }
  }

  return getChatById(keepId);
}

// Message helpers
async function createMessage({ id, chatId, from, type, content, repliedTo }) {
  const p = await getPool();
  const createdAt = new Date();
  const contentJson = JSON.stringify(content === undefined ? null : content);
  await p.execute('INSERT INTO messages (id, chat_id, from_user, type, content, replied_to, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, chatId, from, type, contentJson, repliedTo || null, createdAt]);
  return findMessageById(id);
}

async function findMessageById(id) {
  const p = await getPool();
  const [rows] = await p.execute('SELECT * FROM messages WHERE id = ? LIMIT 1', [id]);
  const msg = rows[0];
  if (!msg) return null;
  try { msg.content = typeof msg.content === 'string' ? JSON.parse(msg.content) : (msg.content || null); } catch { msg.content = msg.content || null; }
  return msg;
}

async function getMessagesForChat(chatId) {
  const p = await getPool();
  const [rows] = await p.execute('SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC', [chatId]);
  for (const r of rows) {
    try { r.content = typeof r.content === 'string' ? JSON.parse(r.content) : (r.content || null); } catch { r.content = r.content || null; }
  }
  return rows;
}

async function getMessagesForChatSince(chatId, since) {
  const p = await getPool();
  // since expected to be an ISO string or timestamp; use as-is in query
  const [rows] = await p.execute('SELECT * FROM messages WHERE chat_id = ? AND created_at > ? ORDER BY created_at ASC', [chatId, since]);
  for (const r of rows) {
    try { r.content = typeof r.content === 'string' ? JSON.parse(r.content) : (r.content || null); } catch { r.content = r.content || null; }
  }
  return rows;
}

async function getLatestMessagesForChat(chatId, limit = 20) {
  const p = await getPool();
  const l = Math.max(1, Math.min(1000, Number(limit) || 20));
  const [rows] = await p.execute(`SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at DESC, id DESC LIMIT ${l}`, [chatId]);
  for (const r of rows) {
    try { r.content = typeof r.content === 'string' ? JSON.parse(r.content) : (r.content || null); } catch { r.content = r.content || null; }
  }
  return rows.reverse();
}

async function getMessagesForChatBefore(chatId, beforeMessageId, limit = 20) {
  const p = await getPool();
  const [beforeRows] = await p.execute('SELECT created_at FROM messages WHERE id = ? AND chat_id = ? LIMIT 1', [beforeMessageId, chatId]);
  if (!beforeRows || beforeRows.length === 0) return [];
  const cutoff = beforeRows[0].created_at;
  const l = Math.max(1, Math.min(1000, Number(limit) || 20));
  const [rows] = await p.execute(
    `SELECT * FROM messages WHERE chat_id = ? AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ${l}`,
    [chatId, cutoff, cutoff, beforeMessageId]
  );
  for (const r of rows) {
    try { r.content = typeof r.content === 'string' ? JSON.parse(r.content) : (r.content || null); } catch { r.content = r.content || null; }
  }
  return rows.reverse();
}

async function markMessageDeleted(messageId) {
  const p = await getPool();
  const deletedAt = new Date();
  await p.execute('UPDATE messages SET deleted_at = ? WHERE id = ?', [deletedAt, messageId]);
}

async function addMessageRead(messageId, userId) {
  const p = await getPool();
  await p.execute('INSERT IGNORE INTO message_read (message_id, user_id) VALUES (?, ?)', [messageId, userId]);
}

// Session helpers
async function createSession({ id, userId, expiresAt }) {
  const p = await getPool();
  const createdAt = new Date();
  await p.execute('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)', [id, userId, expiresAt, createdAt]);
  return findSessionById(id);
}

async function findSessionById(id) {
  const p = await getPool();
  const [rows] = await p.execute('SELECT * FROM sessions WHERE id = ? LIMIT 1', [id]);
  const s = rows[0];
  return s || null;
}

async function deleteSession(id) {
  const p = await getPool();
  await p.execute('DELETE FROM sessions WHERE id = ?', [id]);
}

module.exports = {
  init,
  getPool,
  // users
  findUserByMsId,
  findUserByMinecraftId,
  findUserById,
  createUser,
  updateUsername,
  updateUserFaceKey,
  getAllUsers,
  // chats
  createChat,
  getChatById,
  getChatsForUser,
  findSingleChatBetween,
  findSelfChatForUser,
  // messages
  createMessage,
  findMessageById,
  getMessagesForChat,
  getMessagesForChatSince,
  getLatestMessagesForChat,
  getMessagesForChatBefore,
  markMessageDeleted,
  addMessageRead,
  // global messages
  createGlobalMessage,
  findGlobalMessageById,
  getLatestGlobalMessages,
  getGlobalMessagesBefore,
  getGlobalMessagesSince,
  // emoji packs
  createEmojiPack,
  getEmojiPacksForUser,
  findEmojiPackById,
  // media
  createMedia,
  findMediaById,
  getMediaForOwner,
  // sessions
  createSession,
  findSessionById,
  deleteSession
};
