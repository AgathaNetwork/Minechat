const express = require('express');
const { generateId } = require('../utils/id');
const db = require('../db');
const auth = require('../middleware/auth');
const multer = require('multer');
const { uploadBuffer } = require('../utils/oss');
const { getIo } = require('../socket');

const router = express.Router();

router.use(auth);

router.post('/', async (req, res) => {
  const { name, members } = req.body;
  await db.init();
  const chatId = generateId();
  const chat = await db.createChat({
    id: chatId,
    type: members && members.length > 2 ? 'group' : 'single',
    name: name || null,
    members: Array.from(new Set([req.user.id].concat(members || []))),
    createdBy: req.user.id
  });
  res.json(chat);
});

router.get('/', async (req, res) => {
  await db.init();
  let chats = await db.getChatsForUser(req.user.id);
  if (!chats || chats.length === 0) {
    // ensure a self-chat exists
    let self = await db.findSelfChatForUser(req.user.id);
    if (!self) {
      const chatId = generateId();
      self = await db.createChat({ id: chatId, type: 'single', name: null, members: [req.user.id], createdBy: req.user.id });
    }
    chats = await db.getChatsForUser(req.user.id);
  }
  res.json(chats);
});

router.get('/:id', async (req, res) => {
  await db.init();
  const chat = await db.getChatById(req.params.id);
  if (!chat || !chat.members.includes(req.user.id)) return res.status(404).json({ error: 'Chat not found' });
  res.json(chat);
});

// Proxy to get messages for a chat via /chats/:id/messages
router.get('/:id/messages', async (req, res) => {
  await db.init();
  const chat = await db.getChatById(req.params.id);
  if (!chat || !chat.members.includes(req.user.id)) return res.status(404).json({ error: 'Chat not found' });
  const since = req.query.since;
  const msgs = since ? await db.getMessagesForChatSince(chat.id, since) : await db.getMessagesForChat(chat.id);
  res.json(msgs);
});

// Send message to chat via /chats/:id/messages (proxy to messages logic)
const upload = multer({ storage: multer.memoryStorage() });
router.post('/:id/messages', upload.single('file'), async (req, res) => {
  const chatId = req.params.id;
  const { type = 'text', content, repliedTo } = req.body;
  await db.init();
  let chat = await db.getChatById(chatId);
  if (!chat) return res.status(404).json({ error: 'Chat not found' });
  if (!chat.members.includes(req.user.id)) return res.status(403).json({ error: 'Not member of chat' });

  let payload = null;
  if (type === 'file' || req.file) {
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

module.exports = router;
