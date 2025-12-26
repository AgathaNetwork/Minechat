const express = require('express');
const db = require('../db');
const auth = require('../middleware/auth');
const axios = require('axios');
const Jimp = require('jimp');
const { putBuffer, encodeOssKeyForUrl } = require('../utils/oss');

const router = express.Router();

function buildPublicUrl(key) {
  if (!key) return null;
  const base = process.env.OSS_BASE_URL;
  if (base && base.length > 0) return base.replace(/\/$/, '') + '/' + encodeOssKeyForUrl(key);
  if (process.env.OSS_BUCKET && process.env.OSS_ENDPOINT) {
    return `https://${process.env.OSS_BUCKET}.${process.env.OSS_ENDPOINT}/${encodeOssKeyForUrl(key)}`;
  }
  return key;
}

async function getMojangUuidByUsername(username) {
  const u = String(username || '').trim();
  if (!u) return null;
  const resp = await axios.get(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(u)}`, {
    validateStatus: () => true
  });
  if (resp.status === 200 && resp.data && resp.data.id) return resp.data.id;
  return null;
}

async function getSkinUrlByUuid(uuid) {
  const resp = await axios.get(`https://sessionserver.mojang.com/session/minecraft/profile/${encodeURIComponent(uuid)}`, {
    validateStatus: () => true
  });
  if (resp.status !== 200 || !resp.data) throw new Error('Mojang sessionserver response not ok');
  const props = resp.data.properties || [];
  const texturesProp = props.find(p => p && p.name === 'textures');
  if (!texturesProp || !texturesProp.value) throw new Error('Missing textures property');
  const decoded = Buffer.from(texturesProp.value, 'base64').toString('utf8');
  const textures = JSON.parse(decoded);
  const url = textures?.textures?.SKIN?.url;
  if (!url) throw new Error('Missing SKIN url');
  return url;
}

async function extractFacePngFromSkinBuffer(skinBuffer) {
  const skin = await Jimp.read(skinBuffer);
  const w = skin.bitmap.width;
  const h = skin.bitmap.height;
  if (w < 64 || h < 32) throw new Error(`Unexpected skin size: ${w}x${h}`);

  // Base face: (8,8) 8x8; Hat/overlay: (40,8) 8x8
  const face = skin.clone().crop(8, 8, 8, 8);
  const overlay = skin.clone().crop(40, 8, 8, 8);
  face.composite(overlay, 0, 0);

  // Upscale for nicer display
  face.resize(128, 128, Jimp.RESIZE_NEAREST_NEIGHBOR);
  return face.getBufferAsync(Jimp.MIME_PNG);
}

// POST /users/me/face - fetch Minecraft skin via Mojang, extract face, upload to OSS
router.post('/me/face', auth, async (req, res) => {
  try {
    await db.init();
    const user = await db.findUserById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.username) return res.status(400).json({ error: 'Missing minecraft username' });

    const uuid = user.minecraft_id || await getMojangUuidByUsername(user.username);
    if (!uuid) return res.status(400).json({ error: 'Cannot resolve Mojang UUID for user' });

    const skinUrl = await getSkinUrlByUuid(uuid);
    const skinResp = await axios.get(skinUrl, { responseType: 'arraybuffer' });
    const facePng = await extractFacePngFromSkinBuffer(Buffer.from(skinResp.data));

    const key = `face/${user.id}.png`;
    const up = await putBuffer({ buffer: facePng, key, contentType: 'image/png' });
    await db.updateUserFaceKey(user.id, key);

    res.json({ key, url: buildPublicUrl(key), ossUrl: up.url });
  } catch (e) {
    console.error('POST /users/me/face error', e?.message || e);
    res.status(500).json({ error: 'face upload failed', detail: e?.message || String(e) });
  }
});

// GET /users - list all users (id, username)
router.get('/', async (req, res) => {
  try {
    await db.init();
    const users = await db.getAllUsers();
    const mapped = (users || []).map(u => ({
      id: u.id,
      username: u.username,
      faceUrl: buildPublicUrl(u.face_key)
    }));
    res.json(mapped);
  } catch (e) {
    console.error('GET /users error', e?.message || e);
    res.status(500).json({ error: 'Internal error' });
  }
});

// GET /users/me - return current user's public info (same shape as /users/:id)
router.get('/me', auth, async (req, res) => {
  try {
    await db.init();
    const user = await db.findUserById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ id: user.id, username: user.username, faceUrl: buildPublicUrl(user.face_key) });
  } catch (e) {
    console.error('GET /users/me error', e?.message || e);
    res.status(500).json({ error: 'Internal error' });
  }
});

// GET /users/:id - return minimal public user info (id, username)
router.get('/:id', async (req, res) => {
  try {
    await db.init();
    const user = await db.findUserById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ id: user.id, username: user.username, faceUrl: buildPublicUrl(user.face_key) });
  } catch (e) {
    console.error('GET /users/:id error', e?.message || e);
    res.status(500).json({ error: 'Internal error' });
  }
});

module.exports = router;
