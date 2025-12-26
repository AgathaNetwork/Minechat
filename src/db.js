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
      created_at DATETIME
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

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
}

// User helpers
async function findUserByMsId(msId) {
  const p = await getPool();
  const [rows] = await p.execute('SELECT * FROM users WHERE ms_id = ? LIMIT 1', [msId]);
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
  await p.execute('INSERT INTO users (id, ms_id, username, minecraft_id, created_at) VALUES (?, ?, ?, ?, ?)', [id, msId, username, minecraftId, createdAt]);
  return findUserById(id);
}

async function updateUsername(id, username) {
  const p = await getPool();
  await p.execute('UPDATE users SET username = ? WHERE id = ?', [username, id]);
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
    chats.push(c);
  }
  return chats;
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
  const [rows] = await p.execute(
    `SELECT c.* FROM chats c
      WHERE c.type = 'single' AND
        EXISTS (SELECT 1 FROM chat_members m WHERE m.chat_id = c.id AND m.user_id = ?)
      LIMIT 1`,
    [userId]
  );
  for (const chat of rows) {
    const [members] = await p.execute('SELECT user_id FROM chat_members WHERE chat_id = ?', [chat.id]);
    if (members.length === 1 && members[0].user_id === userId) {
      chat.members = members.map(r => r.user_id);
      return chat;
    }
  }
  return null;
}

// Message helpers
async function createMessage({ id, chatId, from, type, content, repliedTo }) {
  const p = await getPool();
  const createdAt = new Date();
  const contentJson = typeof content === 'string' ? content : JSON.stringify(content || null);
  await p.execute('INSERT INTO messages (id, chat_id, from_user, type, content, replied_to, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, chatId, from, type, contentJson, repliedTo || null, createdAt]);
  return findMessageById(id);
}

async function findMessageById(id) {
  const p = await getPool();
  const [rows] = await p.execute('SELECT * FROM messages WHERE id = ? LIMIT 1', [id]);
  const msg = rows[0];
  if (!msg) return null;
  try { msg.content = msg.content ? JSON.parse(msg.content) : null; } catch { }
  return msg;
}

async function getMessagesForChat(chatId) {
  const p = await getPool();
  const [rows] = await p.execute('SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC', [chatId]);
  for (const r of rows) {
    try { r.content = r.content ? JSON.parse(r.content) : null; } catch { }
  }
  return rows;
}

async function getMessagesForChatSince(chatId, since) {
  const p = await getPool();
  // since expected to be an ISO string or timestamp; use as-is in query
  const [rows] = await p.execute('SELECT * FROM messages WHERE chat_id = ? AND created_at > ? ORDER BY created_at ASC', [chatId, since]);
  for (const r of rows) {
    try { r.content = r.content ? JSON.parse(r.content) : null; } catch { }
  }
  return rows;
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
  findUserByMsId,
  findUserById,
  createUser,
  updateUsername,
  createChat,
  getChatById,
  getChatsForUser,
  createMessage,
  getMessagesForChat,
  getMessagesForChatSince,
  findMessageById,
  markMessageDeleted,
  addMessageRead
  ,createSession, findSessionById, deleteSession,
  findSingleChatBetween, findSelfChatForUser
};
