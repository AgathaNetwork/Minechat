const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { uploadBuffer } = require('../utils/oss');
const Jimp = require('jimp');
const { generateId } = require('../utils/id');
const db = require('../db');
const { getIo } = require('../socket');
const auth = require('../middleware/auth');

const router = express.Router();
router.use(auth);

// Use memory storage and upload to OSS
const upload = multer({ storage: multer.memoryStorage() });

// Send message (multipart for files)
router.post('/:chatId/messages', upload.single('file'), async (req, res) => {
  const { chatId } = req.params;
  const { type = 'text', content, repliedTo } = req.body;
  await db.init();
  let chat = await db.getChatById(chatId);
  // If chat not found, allow creating a single chat to a target user (toUserId)
  if (!chat) {
    const toUserId = req.body.toUserId || req.query.toUserId;
    if (!toUserId) return res.status(404).json({ error: 'Chat not found' });
    // find existing single chat between users
    chat = await db.findSingleChatBetween(req.user.id, toUserId);
    if (!chat) {
      const newChatId = generateId();
      chat = await db.createChat({ id: newChatId, type: 'single', name: null, members: [req.user.id, toUserId], createdBy: req.user.id });
    }
  }
  if (!chat.members.includes(req.user.id)) return res.status(403).json({ error: 'Not member of chat' });

  let payload = null;
  if (type === 'file' || req.file) {
    // upload buffer to OSS (images -> PNG + thumbnail)
    try {
      const file = req.file;
      if (file.mimetype && file.mimetype.startsWith('image/')) {
        const image = await Jimp.read(file.buffer);
        const pngBuffer = await image.getBufferAsync(Jimp.MIME_PNG);
        const meta = { width: image.bitmap.width, height: image.bitmap.height };
        const thumb = image.clone().scaleToFit(400, 400);
        const thumbBuffer = await thumb.getBufferAsync(Jimp.MIME_PNG);
        const up = await uploadBuffer({ buffer: pngBuffer, filename: (file.originalname || 'image') + '.png', contentType: 'image/png', prefix: `image/${req.user.id}` });
        const upThumb = await uploadBuffer({ buffer: thumbBuffer, filename: (file.originalname || 'thumb') + '.png', contentType: 'image/png', prefix: `image_thumbnail/${req.user.id}` });
        payload = { url: up.url, filename: file.originalname, mimetype: 'image/png', key: up.key, thumbnailUrl: upThumb.url, thumbKey: upThumb.key, meta };
      } else if (file.mimetype && file.mimetype.startsWith('video/')) {
        const up = await uploadBuffer({ buffer: file.buffer, filename: file.originalname, contentType: file.mimetype, prefix: `video/${req.user.id}` });
        let thumbInfo = null;
        try {
          const ffmpegPath = require('ffmpeg-static');
          const ffmpeg = require('fluent-ffmpeg');
          ffmpeg.setFfmpegPath(ffmpegPath);
          const tmp = require('os').tmpdir();
          const fs = require('fs');
          const vidPath = require('path').join(tmp, `${Date.now()}-${Math.random().toString(36).slice(2,8)}-${file.originalname}`);
          fs.writeFileSync(vidPath, file.buffer);
          const thumbPath = vidPath + '.png';
          await new Promise((resolve, reject) => {
            ffmpeg(vidPath).on('end', resolve).on('error', reject).screenshots({ timestamps: ['1'], filename: require('path').basename(thumbPath), folder: tmp, size: '640x?' });
          });
          const thumbBuffer = fs.readFileSync(thumbPath);
          const upThumb = await uploadBuffer({ buffer: thumbBuffer, filename: (file.originalname || 'thumb') + '.png', contentType: 'image/png', prefix: `video_thumbnail/${req.user.id}` });
          try { fs.unlinkSync(vidPath); fs.unlinkSync(thumbPath); } catch (e) {}
          thumbInfo = { thumbnailUrl: upThumb.url, thumbKey: upThumb.key };
        } catch (e) {
          console.warn('video thumbnail generation failed', e?.message || e);
        }
        payload = Object.assign({ url: up.url, filename: file.originalname, mimetype: file.mimetype, key: up.key }, thumbInfo || {});
      } else {
        const up = await uploadBuffer({ buffer: file.buffer, filename: file.originalname, contentType: file.mimetype, prefix: 'files' });
        payload = { url: up.url, filename: file.originalname, mimetype: file.mimetype, key: up.key };
      }
    } catch (e) {
      console.error('OSS upload failed', e.message || e);
      return res.status(500).json({ error: 'File upload failed' });
    }
  } else {
    try { payload = content ? JSON.parse(content) : null; } catch { payload = content; }
  }

  const msg = await db.createMessage({ id: generateId(), chatId, from: req.user.id, type, content: payload, repliedTo });
  try {
    const io = getIo();
    io.to(`chat:${chatId}`).emit('message.created', msg);
  } catch (e) { }
  res.json(msg);
});

// Recall (soft delete) message
router.post('/:messageId/recall', async (req, res) => {
  const { messageId } = req.params;
  await db.init();
  const msg = await db.findMessageById(messageId);
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  if (msg.from_user !== req.user.id) return res.status(403).json({ error: 'Not sender' });
  await db.markMessageDeleted(messageId);
  try { const io = getIo(); io.to(`chat:${msg.chat_id}`).emit('message.deleted', { id: messageId }); } catch (e) { }
  res.json({ ok: true });
});

// Mark message as read by current user
router.post('/:messageId/read', async (req, res) => {
  const { messageId } = req.params;
  await db.init();
  const msg = await db.findMessageById(messageId);
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  await db.addMessageRead(messageId, req.user.id);
  try { const io = getIo(); io.to(`chat:${msg.chat_id}`).emit('message.read', { messageId, userId: req.user.id }); } catch (e) { }
  res.json({ ok: true });
});

// Get messages for chat
router.get('/:chatId', async (req, res) => {
  const { chatId } = req.params;
  await db.init();
  const chat = await db.getChatById(chatId);
  if (!chat || !chat.members.includes(req.user.id)) return res.status(404).json({ error: 'Chat not found' });
  const since = req.query.since;
  const msgs = since ? await db.getMessagesForChatSince(chatId, since) : await db.getMessagesForChat(chatId);
  res.json(msgs);
});

module.exports = router;
