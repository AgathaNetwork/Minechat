const { query } = require('../utils/multiDb');

const DB = process.env.API_DB || 'api';

async function logApi2({ reqtime, ip, response, reqid }) {
  try {
    await query(DB, 'INSERT INTO api2 (reqtime, ip, response, reqid) VALUES (?, ?, ?, ?)', [reqtime, ip, response, reqid]);
  } catch (e) {
    // best-effort logging
  }
}

module.exports = { logApi2 };
