const express = require('express');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { generateId } = require('../utils/id');
const db = require('../db');
const { getMinecraftProfileFromMsAccessToken } = require('../utils/minecraft');
const { encodeOssKeyForUrl } = require('../utils/oss');
const auth = require('../middleware/auth');

const router = express.Router();

const msClientId = process.env.MICROSOFT_CLIENT_ID;
const msClientSecret = process.env.MICROSOFT_CLIENT_SECRET;
const redirectUri = process.env.OAUTH_REDIRECT_URI;
const frontendLoginRedirect = process.env.FRONTEND_LOGIN_REDIRECT;

// OAuth authorization codes are one-time-use and short-lived.
// Browsers/proxies may accidentally request callback twice (refresh/prefetch/retry).
// Make callback idempotent by caching the final redirect URL for a short time.
// codeHash -> { ts, status, redirectUrl, sessionId, days, promise }
const seenAuthCodes = new Map();
const AUTH_CODE_TTL_MS = 10 * 60 * 1000;

function hashAuthCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex').slice(0, 16);
}

function purgeSeenAuthCodes() {
  const now = Date.now();
  for (const [k, v] of seenAuthCodes.entries()) {
    if (!v || !v.ts || (now - v.ts) > AUTH_CODE_TTL_MS) seenAuthCodes.delete(k);
  }
}

async function withTimeout(promise, ms) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error('Timeout')), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(t);
  }
}

function toBase64UrlJson(obj) {
  const json = JSON.stringify(obj === undefined ? null : obj);
  return Buffer.from(json, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function buildFrontendRedirectUrl({ ok, token, sessionId, user, chats, error, detail }) {
  if (!frontendLoginRedirect) {
    throw new Error('Missing FRONTEND_LOGIN_REDIRECT in .env');
  }
  const url = new URL(frontendLoginRedirect);
  url.searchParams.set('ok', ok ? '1' : '0');
  if (token) url.searchParams.set('token', token);
  if (sessionId) url.searchParams.set('sessionId', sessionId);
  if (user && user.id) url.searchParams.set('userId', user.id);
  if (user && user.username) url.searchParams.set('username', user.username);
  if (user && user.faceUrl) url.searchParams.set('faceUrl', user.faceUrl);
  if (chats) url.searchParams.set('chats', toBase64UrlJson(chats));
  if (error) url.searchParams.set('error', error);
  if (detail) url.searchParams.set('detail', detail);
  return url.toString();
}

function buildPublicUrl(key) {
  if (!key) return null;
  const base = process.env.OSS_BASE_URL;
  if (base && base.length > 0) return base.replace(/\/$/, '') + '/' + encodeOssKeyForUrl(key);
  if (process.env.OSS_BUCKET && process.env.OSS_ENDPOINT) {
    return `https://${process.env.OSS_BUCKET}.${process.env.OSS_ENDPOINT}/${encodeOssKeyForUrl(key)}`;
  }
  return key;
}

function setSessionCookie(res, sessionId, days) {
  if (!sessionId) return;
  const d = Math.max(1, parseInt(days || process.env.SESSION_EXPIRES_DAYS || '30', 10));
  const cookieOptions = {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: d * 24 * 3600 * 1000
  };
  if ((process.env.COOKIE_SECURE || 'false') === 'true' || process.env.NODE_ENV === 'production') cookieOptions.secure = true;
  res.cookie('minechat_session', sessionId, cookieOptions);
}

function sendBrowserRedirect(res, url) {
  // Avoid large Location headers that may cause 502 behind some proxies.
  // We still navigate the browser to the same final URL so the frontend behavior does not change.
  const safeUrl = String(url || '');
  res.status(200);
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="cache-control" content="no-store" />
    <meta http-equiv="pragma" content="no-cache" />
    <meta http-equiv="refresh" content="0;url=${safeUrl.replace(/"/g, '&quot;')}" />
    <title>Redirecting...</title>
  </head>
  <body>
    <script>
      try { window.location.replace(${JSON.stringify(safeUrl)}); } catch (e) { window.location.href = ${JSON.stringify(safeUrl)}; }
    </script>
    <p>Redirecting...</p>
    <p><a href="${safeUrl.replace(/"/g, '&quot;')}">Continue</a></p>
  </body>
</html>`);
}

router.get('/microsoft', (req, res) => {
  const state = generateId();
  const scope = encodeURIComponent('XboxLive.signin offline_access');
  const url = `https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?client_id=${msClientId}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&response_mode=query&scope=${scope}&state=${state}`;
  res.redirect(url);
});

router.get('/callback', async (req, res) => {
  // OAuth callback responses should never be cached.
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
  try {
    // Azure AD may return error directly on callback
    if (req.query && req.query.error) {
      const redir = buildFrontendRedirectUrl({
        ok: false,
        error: String(req.query.error),
        detail: req.query.error_description ? String(req.query.error_description) : undefined
      });
      return sendBrowserRedirect(res, redir);
    }

    const code = req.query.code;
    if (!code) {
      const redir = buildFrontendRedirectUrl({ ok: false, error: 'Missing code' });
      return sendBrowserRedirect(res, redir);
    }

    purgeSeenAuthCodes();
    const codeHash = hashAuthCode(code);
    const existing = seenAuthCodes.get(codeHash);
    if (existing && (Date.now() - existing.ts) <= AUTH_CODE_TTL_MS) {
      console.warn('OAuth callback received duplicate code', {
        codeHash,
        status: existing.status,
        ip: req.ip,
        ua: req.headers['user-agent']
      });

      if (existing.status === 'used' && existing.redirectUrl) {
        setSessionCookie(res, existing.sessionId, existing.days);
        return sendBrowserRedirect(res, existing.redirectUrl);
      }

      if (existing.status === 'inflight' && existing.promise) {
        try {
          const result = await withTimeout(existing.promise, 15000);
          if (result && result.redirectUrl) {
            setSessionCookie(res, result.sessionId, result.days);
            return sendBrowserRedirect(res, result.redirectUrl);
          }
        } catch (e) {
          // fallthrough
        }
      }

      const redir = buildFrontendRedirectUrl({
        ok: false,
        error: 'Auth code reused',
        detail: 'Authorization code was already used or the callback was requested twice. Please restart login.'
      });
      return sendBrowserRedirect(res, redir);
    }

    console.log('OAuth callback exchange start', { codeHash, ip: req.ip });

    const inflight = { ts: Date.now(), status: 'inflight', redirectUrl: null, sessionId: null, days: null, promise: null };
    inflight.promise = (async () => {
      const tokenResp = await axios.post('https://login.microsoftonline.com/consumers/oauth2/v2.0/token', new URLSearchParams({
        client_id: msClientId,
        client_secret: msClientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri
      }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

      const accessToken = tokenResp.data.access_token;

      const profile = await getMinecraftProfileFromMsAccessToken(accessToken);

      await db.init();
      let user = await db.findUserByMinecraftId(profile.id);
      if (!user) {
        const id = generateId();
        await db.createUser({ id, msId: null, username: profile.name, minecraftId: profile.id });
        user = await db.findUserById(id);
      } else {
        if (user.username !== profile.name) {
          await db.updateUsername(user.id, profile.name);
          user = await db.findUserById(user.id);
        }
      }

      const token = jwt.sign({ sub: user.id }, process.env.JWT_SECRET || 'dev_secret', { expiresIn: '30d' });

      const sessionId = generateId();
      const days = parseInt(process.env.SESSION_EXPIRES_DAYS || '30', 10);
      const expiresAt = new Date(Date.now() + days * 24 * 3600 * 1000);
      await db.createSession({ id: sessionId, userId: user.id, expiresAt });

      // ensure self-chat exists
      let selfChat = await db.findSelfChatForUser(user.id);
      if (!selfChat) {
        const chatId = generateId();
        selfChat = await db.createChat({ id: chatId, type: 'single', name: null, members: [user.id], createdBy: user.id });
      }

      const chats = await db.getChatsForUser(user.id);
      const userWithFace = Object.assign({}, user, { faceUrl: buildPublicUrl(user.face_key) });

      const redir = buildFrontendRedirectUrl({ ok: true, token, sessionId, user: userWithFace, chats });

      inflight.status = 'used';
      inflight.ts = Date.now();
      inflight.redirectUrl = redir;
      inflight.sessionId = sessionId;
      inflight.days = days;
      seenAuthCodes.set(codeHash, inflight);

      return { redirectUrl: redir, sessionId, days };
    })();

    seenAuthCodes.set(codeHash, inflight);

    const result = await inflight.promise;

    setSessionCookie(res, result.sessionId, result.days);

    return sendBrowserRedirect(res, result.redirectUrl);
  } catch (e) {
    const aad = e?.response?.data;
    console.error(aad || e.message);
    try {
      // Mark cached code as failed if it exists
      if (req.query && req.query.code) {
        purgeSeenAuthCodes();
        const codeHash = hashAuthCode(req.query.code);
        const existing = seenAuthCodes.get(codeHash);
        if (existing) {
          existing.ts = Date.now();
          existing.status = 'failed';
          existing.redirectUrl = null;
          seenAuthCodes.set(codeHash, existing);
        }
      }
    } catch (e0) {}
    try {
      const detail = (aad && (aad.error_description || aad.error))
        ? String(aad.error_description || aad.error)
        : (e?.message || String(e));
      const redir = buildFrontendRedirectUrl({ ok: false, error: 'Auth failed', detail });
      return sendBrowserRedirect(res, redir);
    } catch (e2) {
      return res.status(500).json({ error: 'Auth failed', details: e?.message });
    }
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
