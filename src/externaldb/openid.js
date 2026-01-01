const { query } = require('../utils/multiDb');

const DB = process.env.OPENID_DB || 'openid';

function getSessionColumnNames() {
  return {
    table: process.env.OPENID_SESSIONS_TABLE || 'sessions',
    sessionCol: process.env.OPENID_SESSIONS_SESSION_COL || 'session',
    usernameCol: process.env.OPENID_SESSIONS_USERNAME_COL || 'username',
    expiryCol: process.env.OPENID_SESSIONS_EXPIRY_COL || 'expiry',
    ipCol: process.env.OPENID_SESSIONS_IP_COL || 'ip'
  };
}

function normalizeExpiryToMs(expiry) {
  const n = Number(expiry);
  if (!Number.isFinite(n)) return null;
  // Heuristic: treat > 1e12 as ms, else seconds.
  return n > 1e12 ? n : n * 1000;
}

async function validateSession(session) {
  const s = String(session || '').trim();
  if (!s) return { return: 0 };

  const { table, sessionCol, usernameCol, expiryCol } = getSessionColumnNames();
  const rows = await query(DB, `SELECT ${usernameCol} AS username, ${expiryCol} AS expiry FROM ${table} WHERE ${sessionCol} = ? ORDER BY ${expiryCol} DESC LIMIT 1`, [s]);
  if (!rows || rows.length === 0) return { return: 0 };

  const expiryMs = normalizeExpiryToMs(rows[0].expiry);
  if (expiryMs !== null && expiryMs < Date.now()) return { return: 0 };
  return { return: 1, user: rows[0].username };
}

async function getFormerName(nowName) {
  const rows = await query(DB, 'SELECT former FROM former_name WHERE now = ? LIMIT 1', [nowName]);
  return rows && rows[0] ? rows[0].former : null;
}

async function getServiceRequirements(username) {
  const rows = await query(DB, 'SELECT bili, postloc, qq, mail, paymentmethod FROM servicerequirements WHERE username = ? LIMIT 1', [username]);
  return rows && rows[0] ? rows[0] : null;
}

async function getDingBind(username) {
  const rows = await query(DB, 'SELECT dingid FROM dingbind WHERE username = ? LIMIT 1', [username]);
  return rows && rows[0] ? (rows[0].dingid || '') : null;
}

async function getIdVerify(username) {
  const rows = await query(DB, 'SELECT realname, id FROM idverify WHERE username = ? LIMIT 1', [username]);
  return rows && rows[0] ? rows[0] : null;
}

async function hasIdVerify(username) {
  const rows = await query(DB, 'SELECT realname FROM idverify WHERE username = ? LIMIT 1', [username]);
  return !!(rows && rows[0]);
}

async function getLoginHistory(username, limit = 2) {
  const { table, usernameCol, expiryCol, ipCol } = getSessionColumnNames();
  const l = Math.max(1, Math.min(20, Number(limit) || 2));
  const rows = await query(DB, `SELECT ${expiryCol} AS expiry, ${ipCol} AS ip FROM ${table} WHERE ${usernameCol} = ? ORDER BY ${expiryCol} DESC LIMIT ${l}`, [username]);
  return rows || [];
}

async function isActivityJoined(username) {
  const rows = await query(DB, 'SELECT name FROM activity WHERE name = ? LIMIT 1', [username]);
  return !!(rows && rows[0]);
}

module.exports = {
  validateSession,
  getFormerName,
  getServiceRequirements,
  getDingBind,
  getIdVerify,
  hasIdVerify,
  getLoginHistory,
  isActivityJoined
};
