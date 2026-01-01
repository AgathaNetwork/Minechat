const { query } = require('../utils/multiDb');
const yaml = require('js-yaml');

const DB = process.env.ESS_DB || 'ess';

function safeYamlLoad(str) {
  try {
    return yaml.load(str);
  } catch {
    return null;
  }
}

async function getEssentialsUserdata(playerName) {
  const rows = await query(DB, 'SELECT userdata FROM essentials_userdata WHERE player_name = ? LIMIT 1', [playerName]);
  if (!rows || rows.length === 0) return null;
  return safeYamlLoad(rows[0].userdata);
}

async function getLogoutLocation(playerName) {
  const data = await getEssentialsUserdata(playerName);
  const loc = data && data.logoutlocation;
  if (!loc) return null;
  return { x: loc.x, y: loc.y, z: loc.z, world: loc.world };
}

async function getHomes(playerName) {
  const data = await getEssentialsUserdata(playerName);
  if (!data) return { existence: 0, homes: [] };
  return { existence: 1, homes: data.homes || [] };
}

module.exports = { getEssentialsUserdata, getLogoutLocation, getHomes };
