const express = require('express');
const multer = require('multer');
const { generateId } = require('../utils/id');
const db = require('../db');
const auth = require('../middleware/auth');
const { uploadBuffer } = require('../utils/oss');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

function buildPublicUrl(key) {
  const base = process.env.OSS_BASE_URL;
  if (base && base.length > 0) return base.replace(/\/$/, '') + '/' + encodeURIComponent(key);
  // fallback to bucket+endpoint (same as uploadBuffer uses)
  if (process.env.OSS_BUCKET && process.env.OSS_ENDPOINT) {
    return `https://${process.env.OSS_BUCKET}.${process.env.OSS_ENDPOINT}/${encodeURIComponent(key)}`;
  }
  return key;
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
    res.status(500).json({ error: 'Internal error' });
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

module.exports = router;
