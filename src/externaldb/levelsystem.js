const { query } = require('../utils/multiDb');

const DB = process.env.LEVELSYSTEM_DB || 'levelsystem';

async function getPlayerLevel(playerName) {
  const rows = await query(DB, 'SELECT currentLevel, currentExp FROM playerdata WHERE playername = ? LIMIT 1', [playerName]);
  if (!rows || rows.length === 0) return null;
  return { level: rows[0].currentLevel, exp: rows[0].currentExp };
}

async function getIncrementalLevelTop50() {
  const sql = `
    SELECT playername, currentLevel, currentExp FROM (
      SELECT playername,
        FLOOR((currentTotal-formerTotal)/3000) as currentLevel,
        FLOOR((currentTotal-formerTotal)%3000) as currentExp
      FROM (
        SELECT currentdata.playername as playername,
          (currentdata.currentLevel*3000+currentdata.currentExp) as currentTotal,
          IFNULL(formerdata.currentLevel*3000+formerdata.currentExp, 0) as formerTotal
        FROM playerdata_diff formerdata
        RIGHT OUTER JOIN playerdata currentdata
          ON formerdata.playername=currentdata.playername
      ) as exptemp
    ) as difftmp
    WHERE !(currentLevel=0 AND currentExp=0)
      AND playername NOT LIKE 'Bot_%'
    ORDER BY currentLevel DESC, currentExp DESC
    LIMIT 50
  `;
  const rows = await query(DB, sql, []);
  return rows || [];
}

async function getLeaderboard() {
  const sql = `
    SELECT playername, currentLevel, currentExp
    FROM playerdata
    WHERE currentLevel > 9
      AND playername NOT LIKE 'Bot_%'
    ORDER BY currentLevel DESC, currentExp DESC
  `;
  const rows = await query(DB, sql, []);
  return rows || [];
}

module.exports = { getPlayerLevel, getIncrementalLevelTop50, getLeaderboard };
