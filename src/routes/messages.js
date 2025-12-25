const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { nanoid } = require('nanoid');
const db = require('../db');
const auth = require('../middleware/auth');

const router = express.Router();
router.use(auth);

const uploadsDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: function (req, file, cb) { cb(null, uploadsDir); },
  filename: function (req, file, cb) { cb(null, `${Date.now()}-${file.originalname}`); }
});
const upload = multer({ storage });

// Send message (multipart for files)
router.post('/:chatId/messages', upload.single('file'), async (req, res) => {
  const { chatId } = req.params;
  const { type = 'text', content, repliedTo } = req.body;
  await db.init();
  const chat = await db.getChatById(chatId);
  if (!chat || !chat.members.includes(req.user.id)) return res.status(404).json({ error: 'Chat not found' });

  let payload = null;
  if (type === 'file' || req.file) {
    payload = { url: `/uploads/${req.file.filename}`, filename: req.file.originalname, mimetype: req.file.mimetype };
  } else {
    try { payload = content ? JSON.parse(content) : null; } catch { payload = content; }
  }

  const msg = await db.createMessage({ id: nanoid(), chatId, from: req.user.id, type, content: payload, repliedTo });
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
  res.json({ ok: true });
});

// Mark message as read by current user
router.post('/:messageId/read', async (req, res) => {
  const { messageId } = req.params;
  await db.init();
  const msg = await db.findMessageById(messageId);
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  await db.addMessageRead(messageId, req.user.id);
  res.json({ ok: true });
});

// Get messages for chat
router.get('/:chatId', async (req, res) => {
  const { chatId } = req.params;
  await db.init();
  const chat = await db.getChatById(chatId);
  if (!chat || !chat.members.includes(req.user.id)) return res.status(404).json({ error: 'Chat not found' });
  const msgs = await db.getMessagesForChat(chatId);
  res.json(msgs);
});

module.exports = router;
