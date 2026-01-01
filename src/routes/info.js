const express = require('express');

const openid = require('../externaldb/openid');
const plt = require('../externaldb/plt');
const authme = require('../externaldb/authme');
const ess = require('../externaldb/ess');
const levelsystem = require('../externaldb/levelsystem');
const co = require('../externaldb/co');
const api = require('../externaldb/api');

const minechatAuth = require('../middleware/auth');

const router = express.Router();

function getClientIp(req) {
  const xfwd = req.headers['x-forwarded-for'];
  if (typeof xfwd === 'string' && xfwd.trim()) return xfwd.split(',')[0].trim();
  return req.ip;
}

async function bestEffortLog(req, response, reqid = '') {
  try {
    await api.logApi2({
      reqtime: new Date(),
      ip: getClientIp(req),
      response: typeof response === 'string' ? response : JSON.stringify(response),
      reqid: String(reqid || '')
    });
  } catch (e) {
    // ignore
  }
}

async function resolveUsername(req) {
  // Only accept Minechat auth (Bearer / cookie)
  if (req.user && req.user.username) return String(req.user.username);
  return null;
}

function wrap(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (e) {
      console.error('[/info] error:', e);
      res.status(500).json({ return: 0, error: 'internal_error' });
    }
  };
}

// Allow Minechat auth if present, but don't require it.
router.use((req, res, next) => minechatAuth(req, res, () => next()).catch(() => next()));

// --- Public-ish endpoints (no session required) ---

// GET /info/playerBrief?username=xxx - lookup other player's brief info
// Returns: level, regDate, lastLogin
router.get('/playerBrief', wrap(async (req, res) => {
  const name = String((req.query && (req.query.username || req.query.name)) || '').trim();
  if (!name) return res.json({ return: 0, error: 'missing_username' });

  async function fetchByPlayerName(playerName) {
    const [level, auth] = await Promise.all([
      levelsystem.getPlayerLevel(playerName),
      authme.getAuthmeUser(playerName)
    ]);

    return {
      level: level ? level.level : null,
      regDate: auth ? auth.regdate : null,
      lastLogin: auth ? auth.lastlogin : null
    };
  }

  let data = await fetchByPlayerName(name);
  if (data.level === null && data.regDate === null && data.lastLogin === null) {
    const former = await openid.getFormerName(name);
    if (former) data = await fetchByPlayerName(former);
  }

  if (data.level === null && data.regDate === null && data.lastLogin === null) {
    return res.json({ return: 0 });
  }

  return res.json({ return: 1, username: name, ...data });
}));

router.get('/geoIp', wrap(async (req, res) => {
  const axios = require('axios');
  const ip = String((req.query && req.query.ip) || getClientIp(req) || '').trim();
  if (!ip) return res.json({ return: 0 });

  const endpoint = process.env.GEOIP_ENDPOINT || 'http://ip-api.com/json/';
  const url = endpoint.endsWith('/') ? `${endpoint}${encodeURIComponent(ip)}` : `${endpoint}/${encodeURIComponent(ip)}`;

  const r = await axios.get(url, { timeout: 8000 });
  res.json(r.data);
}));

router.get('/getPlayerPrefix', wrap(async (req, res) => {
  const name = String((req.query && (req.query.name || req.query.username)) || '').trim();
  if (!name) return res.json({ return: 0 });

  let prefix = await plt.getCurrentPrefix(name);
  if (!prefix) {
    const former = await openid.getFormerName(name);
    if (former) prefix = await plt.getCurrentPrefix(former);
  }
  res.json({ return: 1, prefix: prefix || '' });
}));

router.get('/getLeaderboard', wrap(async (req, res) => {
  const rows = await levelsystem.getLeaderboard();
  res.json({ return: 1, list: rows });
}));

router.get('/incrementalLevel', wrap(async (req, res) => {
  const rows = await levelsystem.getIncrementalLevelTop50();
  res.json({ return: 1, list: rows });
}));

router.get('/getOnlineStatus', wrap(async (req, res) => {
  const rows = await authme.getOnlineStatusAll();
  res.json({ return: 1, list: rows });
}));

// --- Auth-required endpoints (Minechat auth) ---

router.get('/serviceRequirements', wrap(async (req, res) => {
  const username = await resolveUsername(req);
  if (!username) return res.status(401).json({ return: 0 });

  const data = await openid.getServiceRequirements(username);
  const resp = data ? { return: 1, ...data } : { return: 0 };
  await bestEffortLog(req, resp, 'serviceRequirements');
  res.json(resp);
}));

router.get('/dingBind', wrap(async (req, res) => {
  const username = await resolveUsername(req);
  if (!username) return res.status(401).json({ return: 0 });

  const dingid = await openid.getDingBind(username);
  const resp = dingid === null ? { return: 0 } : { return: 1, dingid };
  await bestEffortLog(req, resp, 'dingBind');
  res.json(resp);
}));

router.get('/getId', wrap(async (req, res) => {
  const username = await resolveUsername(req);
  if (!username) return res.status(401).json({ return: 0 });

  const data = await openid.getIdVerify(username);
  const resp = data ? { return: 1, existence: 1, ...data } : { return: 1, existence: 0 };
  await bestEffortLog(req, resp, 'getId');
  res.json(resp);
}));

router.get('/getLoginHistory', wrap(async (req, res) => {
  const username = await resolveUsername(req);
  if (!username) return res.status(401).json({ return: 0 });

  const history = await openid.getLoginHistory(username, 2);
  const resp = { return: 1, history };
  await bestEffortLog(req, resp, 'getLoginHistory');
  res.json(resp);
}));

router.get('/getActivity', wrap(async (req, res) => {
  const username = await resolveUsername(req);
  if (!username) return res.status(401).json({ return: 0 });

  const joined = await openid.isActivityJoined(username);
  const resp = { return: 1, joined: joined ? 1 : 0 };
  await bestEffortLog(req, resp, 'getActivity');
  res.json(resp);
}));

router.get('/homes', wrap(async (req, res) => {
  const username = await resolveUsername(req);
  if (!username) return res.status(401).json({ return: 0 });

  const playerName = String((req.query && (req.query.name || req.query.username)) || username).trim();
  const resp = await ess.getHomes(playerName);
  await bestEffortLog(req, resp, 'homes');
  res.json(resp);
}));

router.get('/getPlayerData', wrap(async (req, res) => {
  const username = await resolveUsername(req);
  if (!username) return res.status(401).json({ return: 0 });

  const former = await openid.getFormerName(username);
  const playerName = former || username;

  const [prefix, homes, level, auth, uuid] = await Promise.all([
    plt.getCurrentPrefix(playerName),
    ess.getHomes(playerName),
    levelsystem.getPlayerLevel(playerName),
    authme.getAuthmeUser(playerName),
    co.getUuidByUser(username)
  ]);

  const resp = {
    return: 1,
    username,
    playerName,
    former: former || '',
    prefix: prefix || '',
    uuid: uuid || '',
    homes,
    level: level ? level.level : null,
    exp: level ? level.exp : null,
    authme: auth || null
  };

  await bestEffortLog(req, resp, 'getPlayerData');
  res.json(resp);
}));

// Old routes that existed but schema not yet migrated here.
router.get('/playTime', wrap(async (req, res) => {
  res.json({ return: 0, error: 'not_implemented' });
}));

router.get('/getIndex', wrap(async (req, res) => {
  res.json({ return: 0, error: 'not_implemented' });
}));

module.exports = router;
