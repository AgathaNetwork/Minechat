const express = require('express');
const multer = require('multer');
const Jimp = require('jimp');
const { generateId } = require('../utils/id');
const db = require('../db');
const auth = require('../middleware/auth');
const { uploadBuffer, encodeOssKeyForUrl } = require('../utils/oss');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

function buildPublicUrl(key) {
  const base = process.env.OSS_BASE_URL;
  if (base && base.length > 0) return base.replace(/\/$/, '') + '/' + encodeOssKeyForUrl(key);
  if (process.env.OSS_BUCKET && process.env.OSS_ENDPOINT) {
    return `https://${process.env.OSS_BUCKET}.${process.env.OSS_ENDPOINT}/${encodeOssKeyForUrl(key)}`;
  }
  return key;
}

router.use(auth);

// POST /images - upload image, convert to PNG and thumbnail. Returns media record.
router.post('/', upload.single('file'), async (req, res) => {
  try {
    await db.init();
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'file is required' });
    if (!file.mimetype || !file.mimetype.startsWith('image/')) return res.status(400).json({ error: 'only images allowed' });

    const image = await Jimp.read(file.buffer);
    const pngBuffer = await image.getBufferAsync(Jimp.MIME_PNG);
    const meta = { width: image.bitmap.width, height: image.bitmap.height };
    const thumb = image.clone().scaleToFit(400, 400);
    const thumbBuffer = await thumb.getBufferAsync(Jimp.MIME_PNG);

    const up = await uploadBuffer({ buffer: pngBuffer, filename: (file.originalname || 'image') + '.png', contentType: 'image/png', prefix: `image/${req.user.id}` });
    const upThumb = await uploadBuffer({ buffer: thumbBuffer, filename: (file.originalname || 'thumb') + '.png', contentType: 'image/png', prefix: `image_thumbnail/${req.user.id}` });

    const media = await db.createMedia({ id: generateId(), ownerId: req.user.id, type: 'image/png', originalName: file.originalname, objectKey: up.key, thumbKey: upThumb.key, meta: { originalMimetype: file.mimetype, size: file.size, width: meta.width, height: meta.height } });
    const info = Object.assign({}, media, { url: buildPublicUrl(media.key), thumbnailUrl: buildPublicUrl(media.thumbKey) });
    res.json(info);
  } catch (e) {
    console.error('POST /images error', e?.message || e);
    res.status(500).json({ error: 'Internal error' });
  }
});

// GET /images - list current user's images
router.get('/', async (req, res) => {
  try {
    await db.init();
    const owner = req.query.owner || req.user.id;
    const rows = await db.getMediaForOwner(owner);
    const mapped = rows.map(r => ({ id: r.id, owner_id: r.owner_id, name: r.original_name, created_at: r.created_at, url: buildPublicUrl(r.key), thumbnailUrl: buildPublicUrl(r.thumbKey), meta: r.meta }));
    res.json(mapped);
  } catch (e) {
    console.error('GET /images error', e?.message || e);
    res.status(500).json({ error: 'Internal error' });
  }
});

// GET /images/:id - get media info by id
router.get('/:id', async (req, res) => {
  try {
    await db.init();
    const m = await db.findMediaById(req.params.id);
    if (!m) return res.status(404).json({ error: 'Not found' });
    const info = { id: m.id, owner_id: m.owner_id, name: m.original_name, created_at: m.created_at, url: buildPublicUrl(m.key), thumbnailUrl: buildPublicUrl(m.thumbKey), meta: m.meta };
    res.json(info);
  } catch (e) {
    console.error('GET /images/:id error', e?.message || e);
    res.status(500).json({ error: 'Internal error' });
  }
});

module.exports = router;
