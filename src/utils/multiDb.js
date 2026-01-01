const mysql = require('mysql2/promise');

const MYSQL_HOST = process.env.MYSQL_HOST || '127.0.0.1';
const MYSQL_PORT = process.env.MYSQL_PORT || 3306;
const MYSQL_USER = process.env.MYSQL_USER || 'root';
const MYSQL_PASSWORD = process.env.MYSQL_PASSWORD || '';

// dbName -> pool
const pools = new Map();

function getPool(dbName) {
  const name = String(dbName || '').trim();
  if (!name) throw new Error('multiDb.getPool requires dbName');
  const existing = pools.get(name);
  if (existing) return existing;

  const pool = mysql.createPool({
    host: MYSQL_HOST,
    port: MYSQL_PORT,
    user: MYSQL_USER,
    password: MYSQL_PASSWORD,
    database: name,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    decimalNumbers: true
  });

  pools.set(name, pool);
  return pool;
}

async function query(dbName, sql, params = []) {
  const pool = getPool(dbName);
  const [rows] = await pool.execute(sql, params);
  return rows;
}

module.exports = { getPool, query };
