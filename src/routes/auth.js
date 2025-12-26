const express = require('express');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const { generateId } = require('../utils/id');
const db = require('../db');
const { getMinecraftProfileFromMsAccessToken } = require('../utils/minecraft');
const { encodeOssKeyForUrl } = require('../utils/oss');
const auth = require('../middleware/auth');

const router = express.Router();

const msClientId = process.env.MICROSOFT_CLIENT_ID;
const msClientSecret = process.env.MICROSOFT_CLIENT_SECRET;
const redirectUri = process.env.OAUTH_REDIRECT_URI;

function buildPublicUrl(key) {
  if (!key) return null;
  const base = process.env.OSS_BASE_URL;
  if (base && base.length > 0) return base.replace(/\/$/, '') + '/' + encodeOssKeyForUrl(key);
  if (process.env.OSS_BUCKET && process.env.OSS_ENDPOINT) {
    return `https://${process.env.OSS_BUCKET}.${process.env.OSS_ENDPOINT}/${encodeOssKeyForUrl(key)}`;
  }
  return key;
}

router.get('/microsoft', (req, res) => {
  const state = generateId();
  const scope = encodeURIComponent('XboxLive.signin offline_access');
  const url = `https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?client_id=${msClientId}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&response_mode=query&scope=${scope}&state=${state}`;
  res.redirect(url);
});

router.get('/callback', async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).json({ error: 'Missing code' });

    const tokenResp = await axios.post('https://login.microsoftonline.com/consumers/oauth2/v2.0/token', new URLSearchParams({
      client_id: msClientId,
      client_secret: msClientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri
    }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

    const accessToken = tokenResp.data.access_token;

    // Exchange for Minecraft profile
    const profile = await getMinecraftProfileFromMsAccessToken(accessToken);

    await db.init();
    // Use Microsoft account subject as stable id; fallback to truncated access token
    const msSub = tokenResp.data.id_token || accessToken.substring(0, 12);
    let user = await db.findUserByMsId(msSub);
    if (!user) {
      const id = generateId();
      await db.createUser({ id, msId: msSub, username: profile.name, minecraftId: profile.id });
      user = await db.findUserById(id);
    } else {
      if (user.username !== profile.name) {
        await db.updateUsername(user.id, profile.name);
        user = await db.findUserById(user.id);
      }
    }

    const token = jwt.sign({ sub: user.id }, process.env.JWT_SECRET || 'dev_secret', { expiresIn: '30d' });

    // create server-side session and set cookie
    const sessionId = generateId();
    const days = parseInt(process.env.SESSION_EXPIRES_DAYS || '30', 10);
    const expiresAt = new Date(Date.now() + days * 24 * 3600 * 1000);
    await db.createSession({ id: sessionId, userId: user.id, expiresAt });

    const cookieOptions = {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: days * 24 * 3600 * 1000
    };
    if ((process.env.COOKIE_SECURE || 'false') === 'true' || process.env.NODE_ENV === 'production') cookieOptions.secure = true;

    res.cookie('minechat_session', sessionId, cookieOptions);

    // return token, user and session id
    // ensure self-chat exists
    let selfChat = await db.findSelfChatForUser(user.id);
    if (!selfChat) {
      const chatId = generateId();
      selfChat = await db.createChat({ id: chatId, type: 'single', name: null, members: [user.id], createdBy: user.id });
    }

    // collect all chats for user to return to client
    const chats = await db.getChatsForUser(user.id);

    const userWithFace = Object.assign({}, user, { faceUrl: buildPublicUrl(user.face_key) });
    res.json({ token, user: userWithFace, sessionId, chats });
  } catch (e) {
    console.error(e?.response?.data || e.message);
    res.status(500).json({ error: 'Auth failed', details: e?.message });
  }
});

// POST /auth/logout
// Client calls with credentials: 'include' to send minechat_session cookie.
router.post('/logout', auth, async (req, res) => {
  try {
    await db.init();
    const sessionId = req.cookies && req.cookies.minechat_session;
    if (sessionId) {
      try { await db.deleteSession(sessionId); } catch (e) { }
    }

    const cookieOptions = {
      httpOnly: true,
      sameSite: 'lax'
    };
    if ((process.env.COOKIE_SECURE || 'false') === 'true' || process.env.NODE_ENV === 'production') cookieOptions.secure = true;

    res.clearCookie('minechat_session', cookieOptions);
    res.json({ ok: true });
  } catch (e) {
    console.error('POST /auth/logout error', e?.message || e);
    res.status(500).json({ error: 'Logout failed', detail: e?.message || String(e) });
  }
});

module.exports = router;
