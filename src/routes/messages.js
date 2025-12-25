const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { uploadBuffer } = require('../utils/oss');
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
  const chat = await db.getChatById(chatId);
  if (!chat || !chat.members.includes(req.user.id)) return res.status(404).json({ error: 'Chat not found' });

  let payload = null;
  if (type === 'file' || req.file) {
    // upload buffer to OSS
    try {
      const file = req.file;
      const up = await uploadBuffer({ buffer: file.buffer, filename: file.originalname, contentType: file.mimetype });
      payload = { url: up.url, filename: file.originalname, mimetype: file.mimetype, key: up.key };
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
