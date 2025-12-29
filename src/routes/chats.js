const express = require('express');
const { generateId } = require('../utils/id');
const db = require('../db');
const auth = require('../middleware/auth');
const multer = require('multer');
const { uploadBuffer } = require('../utils/oss');
const Jimp = require('jimp');
const { getIo, emitToUsers } = require('../socket');

const router = express.Router();

router.use(auth);

async function loadChatAsMember(req, res) {
  const chat = await db.getChatById(req.params.id);
  if (!chat) {
    res.status(404).json({ error: 'Chat not found' });
    return null;
  }
  if (!Array.isArray(chat.members) || !chat.members.includes(req.user.id)) {
    res.status(403).json({ error: 'Not member of chat' });
    return null;
  }
  return chat;
}

async function getGroupRole(chat, userId) {
  const isOwner = chat.created_by === userId;
  const isAdmin = !isOwner && (await db.isChatAdmin(chat.id, userId));
  return { isOwner, isAdmin, canManage: isOwner || isAdmin };
}

// POST /chats/group - create a group chat from selected users (including self)
router.post('/group', async (req, res) => {
  try {
    const { name, members } = req.body || {};
    await db.init();

    const uniqueMembers = Array.from(new Set([req.user.id].concat(Array.isArray(members) ? members : [])));
    if (uniqueMembers.length < 3) {
      return res.status(400).json({ error: 'Group chat requires at least 3 members (including yourself)' });
    }

    const chatId = generateId();
    const chat = await db.createChat({
      id: chatId,
      type: 'group',
      name: name || null,
      members: uniqueMembers,
      createdBy: req.user.id
    });
    res.json(chat);
  } catch (e) {
    console.error('POST /chats/group error', e?.message || e);
    res.status(500).json({ error: 'Internal error' });
  }
});

router.post('/', async (req, res) => {
  const { name, members } = req.body;
  await db.init();
  const uniqueMembers = Array.from(new Set([req.user.id].concat(Array.isArray(members) ? members : [])));
  const chatId = generateId();
  const chat = await db.createChat({
    id: chatId,
    type: uniqueMembers.length >= 3 ? 'group' : 'single',
    name: name || null,
    members: uniqueMembers,
    createdBy: req.user.id
  });
  res.json(chat);
});

router.get('/', async (req, res) => {
  await db.init();
  // Always ensure a self-chat exists (even if user already has other chats)
  let self = await db.findSelfChatForUser(req.user.id);
  if (!self) {
    const chatId = generateId();
    self = await db.createChat({ id: chatId, type: 'single', name: null, members: [req.user.id], createdBy: req.user.id });
  }

  let chats = await db.getChatsForUser(req.user.id);

  // De-duplicate historical self-chats (keep the first one we see)
  let keptSelf = false;
  chats = (chats || []).filter(c => {
    if (c.type !== 'single') return true;
    const members = c.members || [];
    const isSelf = members.length === 1 && members[0] === req.user.id;
    if (!isSelf) return true;
    if (keptSelf) return false;
    keptSelf = true;
    return true;
  });
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

// PATCH /chats/:id - update group chat info (currently: name)
router.patch('/:id', async (req, res) => {
  try {
    await db.init();
    const chat = await loadChatAsMember(req, res);
    if (!chat) return;
    if (chat.type !== 'group') return res.status(400).json({ error: 'Only group chats support updates' });

    const { isOwner, isAdmin } = await getGroupRole(chat, req.user.id);
    if (!isOwner && !isAdmin) return res.status(403).json({ error: 'No permission' });

    const { name } = req.body || {};
    const updated = await db.updateChatName(chat.id, typeof name === 'string' ? name : null);

    try {
      emitToUsers(updated.members || [], 'chat.updated', { chat: updated });
    } catch (e) {}

    res.json(updated);
  } catch (e) {
    console.error('PATCH /chats/:id error', e?.message || e);
    res.status(500).json({ error: 'Internal error' });
  }
});

// POST /chats/:id/invite - invite new members to group
router.post('/:id/invite', async (req, res) => {
  try {
    await db.init();
    const chat = await loadChatAsMember(req, res);
    if (!chat) return;
    if (chat.type !== 'group') return res.status(400).json({ error: 'Only group chats support inviting members' });

    const { isOwner, isAdmin } = await getGroupRole(chat, req.user.id);
    if (!isOwner && !isAdmin) return res.status(403).json({ error: 'No permission' });

    const body = req.body || {};
    const raw = Array.isArray(body.userIds) ? body.userIds : (Array.isArray(body.members) ? body.members : []);
    const unique = Array.from(new Set(raw.concat([req.user.id]))).filter(Boolean);
    const existing = new Set(chat.members || []);
    const toAdd = unique.filter(uid => !existing.has(uid));
    if (toAdd.length === 0) return res.json({ chat, added: [] });

    const updated = await db.addChatMembers(chat.id, toAdd);

    try {
      emitToUsers(updated.members || [], 'chat.members.added', { chatId: chat.id, userIds: toAdd });
      emitToUsers(updated.members || [], 'chat.updated', { chat: updated });
    } catch (e) {}

    res.json({ chat: updated, added: toAdd });
  } catch (e) {
    console.error('POST /chats/:id/invite error', e?.message || e);
    res.status(500).json({ error: 'Internal error' });
  }
});

// POST /chats/:id/kick - remove members from group
router.post('/:id/kick', async (req, res) => {
  try {
    await db.init();
    const chat = await loadChatAsMember(req, res);
    if (!chat) return;
    if (chat.type !== 'group') return res.status(400).json({ error: 'Only group chats support kicking members' });

    const { isOwner, isAdmin } = await getGroupRole(chat, req.user.id);
    if (!isOwner && !isAdmin) return res.status(403).json({ error: 'No permission' });

    const body = req.body || {};
    const raw = Array.isArray(body.userIds) ? body.userIds : [];
    const unique = Array.from(new Set(raw)).filter(Boolean);

    const ownerId = chat.created_by;
    if (unique.includes(ownerId)) return res.status(400).json({ error: 'Cannot kick group owner' });
    if (!isOwner && unique.length > 0) {
      // admin cannot kick owner already blocked above; allow admin to kick other admins for simplicity
    }
    if (isOwner && unique.includes(req.user.id)) {
      return res.status(400).json({ error: 'Owner cannot remove themselves; transfer ownership first' });
    }

    const existing = new Set(chat.members || []);
    const toRemove = unique.filter(uid => existing.has(uid));
    if (toRemove.length === 0) return res.json({ chat, removed: [] });

    const updated = await db.removeChatMembers(chat.id, toRemove);

    try {
      // Notify remaining members + removed users
      const targets = Array.from(new Set((updated.members || []).concat(toRemove)));
      emitToUsers(targets, 'chat.members.removed', { chatId: chat.id, userIds: toRemove });
      emitToUsers(targets, 'chat.updated', { chat: updated });
      emitToUsers(toRemove, 'chat.kicked', { chatId: chat.id });
    } catch (e) {}

    res.json({ chat: updated, removed: toRemove });
  } catch (e) {
    console.error('POST /chats/:id/kick error', e?.message || e);
    res.status(500).json({ error: 'Internal error' });
  }
});

// GET /chats/:id/admins - list group owner/admins
router.get('/:id/admins', async (req, res) => {
  try {
    await db.init();
    const chat = await loadChatAsMember(req, res);
    if (!chat) return;
    if (chat.type !== 'group') return res.status(400).json({ error: 'Only group chats have admins' });

    const admins = await db.getChatAdmins(chat.id);
    res.json({ chatId: chat.id, ownerId: chat.created_by, admins });
  } catch (e) {
    console.error('GET /chats/:id/admins error', e?.message || e);
    res.status(500).json({ error: 'Internal error' });
  }
});

// POST /chats/:id/admins - add an admin (owner only)
router.post('/:id/admins', async (req, res) => {
  try {
    await db.init();
    const chat = await loadChatAsMember(req, res);
    if (!chat) return;
    if (chat.type !== 'group') return res.status(400).json({ error: 'Only group chats have admins' });
    if (chat.created_by !== req.user.id) return res.status(403).json({ error: 'Only owner can manage admins' });

    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'Missing userId' });
    if (!chat.members.includes(userId)) return res.status(400).json({ error: 'User must be a member' });
    if (userId === chat.created_by) return res.status(400).json({ error: 'Owner is not an admin record' });

    const admins = await db.addChatAdmin(chat.id, userId);
    try {
      emitToUsers(chat.members || [], 'chat.admins.changed', { chatId: chat.id, ownerId: chat.created_by, admins });
    } catch (e) {}
    res.json({ chatId: chat.id, ownerId: chat.created_by, admins });
  } catch (e) {
    console.error('POST /chats/:id/admins error', e?.message || e);
    res.status(500).json({ error: 'Internal error' });
  }
});

// PUT /chats/:id/admins - replace admin list (owner only)
router.put('/:id/admins', async (req, res) => {
  try {
    await db.init();
    const chat = await loadChatAsMember(req, res);
    if (!chat) return;
    if (chat.type !== 'group') return res.status(400).json({ error: 'Only group chats have admins' });
    if (chat.created_by !== req.user.id) return res.status(403).json({ error: 'Only owner can manage admins' });

    const body = req.body || {};
    const raw = Array.isArray(body.admins) ? body.admins : [];
    const unique = Array.from(new Set(raw)).filter(Boolean).filter(uid => uid !== chat.created_by);
    for (const uid of unique) {
      if (!chat.members.includes(uid)) return res.status(400).json({ error: 'All admins must be members' });
    }

    const admins = await db.replaceChatAdmins(chat.id, unique);
    try {
      emitToUsers(chat.members || [], 'chat.admins.changed', { chatId: chat.id, ownerId: chat.created_by, admins });
    } catch (e) {}
    res.json({ chatId: chat.id, ownerId: chat.created_by, admins });
  } catch (e) {
    console.error('PUT /chats/:id/admins error', e?.message || e);
    res.status(500).json({ error: 'Internal error' });
  }
});

// DELETE /chats/:id/admins/:userId - remove admin (owner only)
router.delete('/:id/admins/:userId', async (req, res) => {
  try {
    await db.init();
    const chat = await loadChatAsMember(req, res);
    if (!chat) return;
    if (chat.type !== 'group') return res.status(400).json({ error: 'Only group chats have admins' });
    if (chat.created_by !== req.user.id) return res.status(403).json({ error: 'Only owner can manage admins' });

    const userId = req.params.userId;
    if (!userId) return res.status(400).json({ error: 'Missing userId' });
    if (userId === chat.created_by) return res.status(400).json({ error: 'Cannot remove owner' });

    const admins = await db.removeChatAdmin(chat.id, userId);
    try {
      emitToUsers(chat.members || [], 'chat.admins.changed', { chatId: chat.id, ownerId: chat.created_by, admins });
    } catch (e) {}
    res.json({ chatId: chat.id, ownerId: chat.created_by, admins });
  } catch (e) {
    console.error('DELETE /chats/:id/admins/:userId error', e?.message || e);
    res.status(500).json({ error: 'Internal error' });
  }
});

// POST /chats/:id/transfer - transfer group ownership (owner only)
router.post('/:id/transfer', async (req, res) => {
  try {
    await db.init();
    const chat = await loadChatAsMember(req, res);
    if (!chat) return;
    if (chat.type !== 'group') return res.status(400).json({ error: 'Only group chats support transfer' });
    if (chat.created_by !== req.user.id) return res.status(403).json({ error: 'Only owner can transfer ownership' });

    const { newOwnerId } = req.body || {};
    if (!newOwnerId) return res.status(400).json({ error: 'Missing newOwnerId' });
    if (!chat.members.includes(newOwnerId)) return res.status(400).json({ error: 'New owner must be a member' });

    const updated = await db.transferChatOwner(chat.id, newOwnerId);
    try {
      emitToUsers(updated.members || [], 'chat.owner.changed', { chatId: chat.id, ownerId: newOwnerId });
      emitToUsers(updated.members || [], 'chat.updated', { chat: updated });
    } catch (e) {}
    res.json(updated);
  } catch (e) {
    console.error('POST /chats/:id/transfer error', e?.message || e);
    res.status(500).json({ error: 'Internal error' });
  }
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
    const file = req.file;
    try {
      if (file.mimetype && file.mimetype.startsWith('image/')) {
        // convert to PNG and create thumbnail using Jimp
        const image = await Jimp.read(file.buffer);
        const pngBuffer = await image.getBufferAsync(Jimp.MIME_PNG);
        const meta = { width: image.bitmap.width, height: image.bitmap.height };
        const thumb = image.clone().scaleToFit(400, 400);
        const thumbBuffer = await thumb.getBufferAsync(Jimp.MIME_PNG);
        const up = await uploadBuffer({ buffer: pngBuffer, filename: (file.originalname || 'image') + '.png', contentType: 'image/png', prefix: `image/${req.user.id}` });
        const upThumb = await uploadBuffer({ buffer: thumbBuffer, filename: (file.originalname || 'thumb') + '.png', contentType: 'image/png', prefix: `image_thumbnail/${req.user.id}` });
        payload = { url: up.url, filename: file.originalname, mimetype: 'image/png', key: up.key, thumbnailUrl: upThumb.url, thumbKey: upThumb.key, meta };
      } else if (file.mimetype && file.mimetype.startsWith('video/')) {
        // upload original video and attempt to extract thumbnail
        const up = await uploadBuffer({ buffer: file.buffer, filename: file.originalname, contentType: file.mimetype, prefix: `video/${req.user.id}` });
        let thumbInfo = null;
        try {
          const ffmpegPath = require('ffmpeg-static');
          const ffmpeg = require('fluent-ffmpeg');
          ffmpeg.setFfmpegPath(ffmpegPath);
          // write temp file then extract a single frame
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
          // cleanup
          try { fs.unlinkSync(vidPath); fs.unlinkSync(thumbPath); } catch (e) {}
          thumbInfo = { thumbnailUrl: upThumb.url, thumbKey: upThumb.key };
        } catch (e) {
          // ffmpeg not available or failed; skip thumbnail
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
    emitToUsers(chat.members || [], 'message.created', msg);
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
