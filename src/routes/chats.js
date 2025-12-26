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
  // enrich chats with displayName
  const userCache = {};
  async function getUser(id) {
    if (!userCache[id]) userCache[id] = db.findUserById(id);
    return userCache[id];
  }

  const enriched = await Promise.all(chats.map(async c => {
    const chat = Object.assign({}, c);
    if (chat.type === 'group') {
      chat.displayName = chat.name || '群聊';
    } else {
      // single chat: show other user's username, or self
      const members = chat.members || [];
      if (members.length === 1) {
        const u = await getUser(members[0]);
        chat.displayName = u ? u.username : '我';
      } else {
        const otherId = members.find(m => m !== req.user.id) || members[0];
        const u = await getUser(otherId);
        chat.displayName = u ? u.username : '对方';
      }
    }
    return chat;
  }));

  res.json(enriched);
});

router.get('/:id', async (req, res) => {
  await db.init();
  const chat = await db.getChatById(req.params.id);
  if (!chat || !chat.members.includes(req.user.id)) return res.status(404).json({ error: 'Chat not found' });
  // compute displayName
  if (chat.type === 'group') chat.displayName = chat.name || '群聊';
  else {
    const members = chat.members || [];
    if (members.length === 1) {
      const u = await db.findUserById(members[0]);
      chat.displayName = u ? u.username : '我';
    } else {
      const otherId = members.find(m => m !== req.user.id) || members[0];
      const u = await db.findUserById(otherId);
      chat.displayName = u ? u.username : '对方';
    }
  }
  res.json(chat);
});

// Proxy to get messages for a chat via /chats/:id/messages
router.get('/:id/messages', async (req, res) => {
  await db.init();
  const chat = await db.getChatById(req.params.id);
  if (!chat || !chat.members.includes(req.user.id)) return res.status(404).json({ error: 'Chat not found' });
  const since = req.query.since;
  const before = req.query.before; // message id to page before (exclusive)
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '20', 10)));

  let msgs;
  if (since) {
    msgs = await db.getMessagesForChatSince(chat.id, since);
  } else if (before) {
    msgs = await db.getMessagesForChatBefore(chat.id, before, limit);
  } else {
    msgs = await db.getLatestMessagesForChat(chat.id, limit);
  }
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

// POST /chats/with/:userId - find or create single chat with given user
router.post('/with/:userId', async (req, res) => {
  const otherId = req.params.userId;
  await db.init();
  if (!otherId) return res.status(400).json({ error: 'Missing userId' });
  const otherUser = await db.findUserById(otherId);
  if (!otherUser) return res.status(404).json({ error: 'User not found' });

  // if requesting self, ensure self-chat exists
  if (otherId === req.user.id) {
    let self = await db.findSelfChatForUser(req.user.id);
    if (!self) {
      const chatId = generateId();
      self = await db.createChat({ id: chatId, type: 'single', name: null, members: [req.user.id], createdBy: req.user.id });
    }
    return res.json({ chatId: self.id, chat: self });
  }

  // find existing single chat between two users
  let chat = await db.findSingleChatBetween(req.user.id, otherId);
  if (!chat) {
    const chatId = generateId();
    chat = await db.createChat({ id: chatId, type: 'single', name: null, members: [req.user.id, otherId], createdBy: req.user.id });
  }
  res.json({ chatId: chat.id, chat });
});

module.exports = router;
