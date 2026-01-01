const { query } = require('../utils/multiDb');

const DB = process.env.AUTHME_DB || 'authme';

async function getAuthmeUser(realname) {
  const rows = await query(DB, 'SELECT realname, regdate, lastlogin, isLogged, ip FROM authme WHERE realname = ? LIMIT 1', [realname]);
  return rows && rows[0] ? rows[0] : null;
}

async function getOnlineStatusAll() {
  const rows = await query(DB, 'SELECT realname, isLogged FROM authme', []);
  return rows || [];
}

module.exports = { getAuthmeUser, getOnlineStatusAll };
