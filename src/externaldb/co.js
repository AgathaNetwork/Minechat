const { query } = require('../utils/multiDb');

const DB = process.env.CO_DB || 'co';

async function getUuidByUser(username) {
  const rows = await query(DB, 'SELECT uuid FROM co_user WHERE user = ? LIMIT 1', [username]);
  return rows && rows[0] ? rows[0].uuid : null;
}

module.exports = { getUuidByUser };
