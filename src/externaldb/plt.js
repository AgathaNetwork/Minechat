const { query } = require('../utils/multiDb');

const DB = process.env.PLT_DB || 'plt';

async function getCurrentPrefix(playerName) {
  const rows = await query(DB, 'SELECT title_name FROM title_player WHERE player_name = ? AND is_use = 1 LIMIT 1', [playerName]);
  return rows && rows[0] ? rows[0].title_name : null;
}

async function getAllActivePrefixes() {
  const rows = await query(DB, 'SELECT player_name, title_name FROM title_player WHERE is_use = 1', []);
  return (rows || []).map(r => ({ name: r.player_name, prefix: r.title_name }));
}

module.exports = { getCurrentPrefix, getAllActivePrefixes };
