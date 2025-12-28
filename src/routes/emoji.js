const express = require('express');
const multer = require('multer');
const { generateId } = require('../utils/id');
const db = require('../db');
const auth = require('../middleware/auth');
const { uploadBuffer, encodeOssKeyForUrl } = require('../utils/oss');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

function buildPublicUrl(key) {
  const base = process.env.OSS_BASE_URL;
  if (base && base.length > 0) return base.replace(/\/$/, '') + '/' + encodeOssKeyForUrl(key);
  // fallback to bucket+endpoint (same as uploadBuffer uses)
  if (process.env.OSS_BUCKET && process.env.OSS_ENDPOINT) {
    return `https://${process.env.OSS_BUCKET}.${process.env.OSS_ENDPOINT}/${encodeOssKeyForUrl(key)}`;
  }
  return key;
}

function tryParseOssKeyFromUrl(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    const path = u.pathname || '';
    const key = path.replace(/^\/+/, '');
    if (!key) return null;
    return key
      .split('/')
      .map(seg => decodeURIComponent(seg))
      .join('/');
  } catch {
    return null;
  }
}

async function resolveEmojiPackFromMessageContent(content) {
  if (!content) return null;

  // Case 1: content is a string
  if (typeof content === 'string') {
    // Might be a URL
    if (/^https?:\/\//i.test(content)) {
      const key = tryParseOssKeyFromUrl(content);
      if (!key) return null;
      return { key, name: 'Collected Emoji', meta: { collected: true, source: 'url' } };
    }
    // Might be an emoji pack id (uuid) or an OSS key
    const byId = await db.findEmojiPackById(content);
    if (byId && byId.key) return byId;
    return { key: content, name: 'Collected Emoji', meta: { collected: true, source: 'key' } };
  }

  // Case 2: content is an object
  if (typeof content === 'object') {
    // Common id fields that may reference emoji_packs.id
    const packId = content.id || content.packId || content.pack_id || content.emojiPackId || content.emoji_pack_id || content.emojiId || content.emoji_id;
    if (packId) {
      const byId = await db.findEmojiPackById(packId);
      if (byId && byId.key) return byId;
    }

    // Direct key fields
    const key = content.key || content.object_key || content.objectKey;
    if (key) {
      return {
        key,
        name: content.name || content.filename || 'Collected Emoji',
        meta: content.meta || { filename: content.filename, mimetype: content.mimetype }
      };
    }

    // URL field
    const urlKey = tryParseOssKeyFromUrl(content.url);
    if (urlKey) {
      return {
        key: urlKey,
        name: content.name || content.filename || 'Collected Emoji',
        meta: content.meta || { filename: content.filename, mimetype: content.mimetype, source: 'url' }
      };
    }
  }

  return null;
}

router.use(auth);

// POST /emoji - upload an emoji pack (file) for current user
router.post('/', upload.single('file'), async (req, res) => {
  try {
    await db.init();
    const file = req.file;
    const name = req.body.name || (file && file.originalname) || 'pack';
    if (!file) return res.status(400).json({ error: 'file is required' });
    const up = await uploadBuffer({ buffer: file.buffer, filename: file.originalname, contentType: file.mimetype, prefix: 'emoji' });
    const pack = await db.createEmojiPack({ id: generateId(), userId: req.user.id, name, key: up.key, meta: { filename: file.originalname, mimetype: file.mimetype, size: file.size } });
    const url = buildPublicUrl(pack.key);
    res.json(Object.assign({}, pack, { url }));
  } catch (e) {
    console.error('POST /emoji error', e?.message || e);
    res.status(500).json({
      error: 'upload failed',
      detail: e?.message || String(e),
      code: e?.code || undefined
    });
  }
});

// GET /emoji - list current user's emoji packs
router.get('/', async (req, res) => {
  try {
    await db.init();
    const packs = await db.getEmojiPacksForUser(req.user.id);
    const mapped = packs.map(p => ({ id: p.id, name: p.name, created_at: p.created_at, url: buildPublicUrl(p.key), meta: p.meta }));
    res.json(mapped);
  } catch (e) {
    console.error('GET /emoji error', e?.message || e);
    res.status(500).json({ error: 'Internal error' });
  }
});

// GET /emoji/:id - get emoji pack info (requires login but public to all users)
router.get('/:id', async (req, res) => {
  try {
    await db.init();
    const pack = await db.findEmojiPackById(req.params.id);
    if (!pack) return res.status(404).json({ error: 'Not found' });
    const info = { id: pack.id, user_id: pack.user_id, name: pack.name, created_at: pack.created_at, url: buildPublicUrl(pack.key), meta: pack.meta };
    res.json(info);
  } catch (e) {
    console.error('GET /emoji/:id error', e?.message || e);
    res.status(500).json({ error: 'Internal error' });
  }
});

// POST /emoji/collect/:messageId - collect emoji pack from a message
router.post('/collect/:messageId', async (req, res) => {
  try {
    await db.init();
    const messageId = req.params.messageId;
    
    // Find the message
    const message = await db.findMessageById(messageId);
    if (!message) return res.status(404).json({ error: 'Message not found' });

    // Security: ensure current user can access the chat of this message
    if (message.chat_id) {
      const chat = await db.getChatById(message.chat_id);
      if (!chat || !Array.isArray(chat.members) || !chat.members.includes(req.user.id)) {
        return res.status(403).json({ error: 'Not allowed' });
      }
    }
    
    // Check if it's an emoji/sticker message
    if (message.type !== 'emoji' && message.type !== 'sticker') {
      return res.status(400).json({ error: 'Message is not an emoji pack' });
    }
    
    // Resolve emoji pack reference from message content.
    // DB schema: emoji_packs uses object_key as the OSS key; message.content might store pack id, key, or url.
    const resolved = await resolveEmojiPackFromMessageContent(message.content);
    if (!resolved || !resolved.key) {
      return res.status(400).json({
        error: 'Message does not contain valid emoji pack data',
        detail: 'Expected message.content to include emoji pack id/key/url'
      });
    }
    
    // Check if user already has this emoji pack (same key)
    const existingPacks = await db.getEmojiPacksForUser(req.user.id);
    const alreadyHas = existingPacks.some(p => p.key === resolved.key);
    if (alreadyHas) {
      return res.status(400).json({ error: 'You already have this emoji pack' });
    }
    
    // Create a new emoji pack entry for current user with the same OSS key
    const name = resolved.name || 'Collected Emoji';
    const meta = Object.assign({}, resolved.meta || {}, { collected: true, originalMessageId: messageId });
    
    const pack = await db.createEmojiPack({
      id: generateId(),
      userId: req.user.id,
      name,
      key: resolved.key, // Reuse the same OSS key
      meta
    });
    
    const url = buildPublicUrl(pack.key);
    res.json(Object.assign({}, pack, { url }));
  } catch (e) {
    console.error('POST /emoji/collect/:messageId error', e?.message || e);
    res.status(500).json({
      error: 'Collect failed',
      detail: e?.message || String(e)
    });
  }
});

module.exports = router;
