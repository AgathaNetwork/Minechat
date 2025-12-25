const express = require('express');
const { generateId } = require('../utils/id');
const db = require('../db');
const auth = require('../middleware/auth');

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
  const chats = await db.getChatsForUser(req.user.id);
  res.json(chats);
});

router.get('/:id', async (req, res) => {
  await db.init();
  const chat = await db.getChatById(req.params.id);
  if (!chat || !chat.members.includes(req.user.id)) return res.status(404).json({ error: 'Chat not found' });
  res.json(chat);
});

module.exports = router;
