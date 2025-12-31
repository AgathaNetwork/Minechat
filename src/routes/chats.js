const express = require('express');
const { generateId } = require('../utils/id');
const db = require('../db');
const auth = require('../middleware/auth');
const multer = require('multer');
const { uploadBuffer, putBuffer, encodeOssKeyForUrl } = require('../utils/oss');
const Jimp = require('jimp');
const { getIo, emitToUsers } = require('../socket');

const router = express.Router();

router.use(auth);

const upload = multer({ storage: multer.memoryStorage() });

function buildPublicUrl(key) {
  if (!key) return null;
  const base = process.env.OSS_BASE_URL;
  if (base && base.length > 0) return base.replace(/\/$/, '') + '/' + encodeOssKeyForUrl(key);
  if (process.env.OSS_BUCKET && process.env.OSS_ENDPOINT) {
    return `https://${process.env.OSS_BUCKET}.${process.env.OSS_ENDPOINT}/${encodeOssKeyForUrl(key)}`;
  }
  return key;
}

function attachChatAvatar(chat) {
  if (!chat) return chat;
  chat.avatarUrl = buildPublicUrl(chat.avatar_key);
  return chat;
}

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

    attachChatAvatar(chat);

    try {
      emitToUsers(chat.members || uniqueMembers, 'chat.created', { chat });
    } catch (e) {}
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

  attachChatAvatar(chat);

  if (chat && chat.type === 'group') {
    try {
      emitToUsers(chat.members || uniqueMembers, 'chat.created', { chat });
    } catch (e) {}
  }
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
    attachChatAvatar(chat);
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
    attachChatAvatar(updated);

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
    attachChatAvatar(updated);

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
    attachChatAvatar(updated);
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

  const messageIds = (msgs || []).map(m => m.id).filter(Boolean);
  if (messageIds.length > 0) {
    if (chat.type === 'group') {
      const counts = await db.getMessageReadCounts(messageIds);
      for (const m of msgs) {
        m.readCount = counts[m.id] || 0;
      }
    } else if (chat.type === 'single') {
      const otherId = (chat.members || []).find(uid => uid !== req.user.id);
      // Self chat: only me in members => don't return read status.
      if (otherId) {
        const otherReadSet = await db.getUserReadMessageIds(messageIds, otherId);
        for (const m of msgs) {
          if (m.from_user === req.user.id) {
            m.read = otherReadSet.has(m.id);
          }
        }
      }
    }
  }

  res.json(msgs);
});

// POST /chats/:id/avatar - set group avatar (owner/admin only)
router.post('/:id/avatar', upload.single('file'), async (req, res) => {
  try {
    await db.init();
    const chat = await loadChatAsMember(req, res);
    if (!chat) return;
    if (chat.type !== 'group') return res.status(400).json({ error: 'Only group chats support avatar' });

    const { isOwner, isAdmin } = await getGroupRole(chat, req.user.id);
    if (!isOwner && !isAdmin) return res.status(403).json({ error: 'No permission' });

    const file = req.file;
    if (!file || !file.buffer) return res.status(400).json({ error: 'Missing file' });
    if (file.mimetype && !file.mimetype.startsWith('image/')) {
      return res.status(400).json({ error: 'Avatar must be an image' });
    }

    const image = await Jimp.read(file.buffer);
    const w = image.bitmap.width;
    const h = image.bitmap.height;
    if (!w || !h) return res.status(400).json({ error: 'Invalid image' });

    const size = Math.min(w, h);
    const x = Math.floor((w - size) / 2);
    const y = Math.floor((h - size) / 2);

    image.crop(x, y, size, size);
    image.resize(256, 256, Jimp.RESIZE_BILINEAR);
    const pngBuffer = await image.getBufferAsync(Jimp.MIME_PNG);

    const key = `group_avatar/${chat.id}.png`;
    await putBuffer({ buffer: pngBuffer, key, contentType: 'image/png' });

    const updated = await db.updateChatAvatarKey(chat.id, key);
    attachChatAvatar(updated);

    try {
      emitToUsers(updated.members || [], 'chat.updated', { chat: updated });
      emitToUsers(updated.members || [], 'chat.avatar.updated', { chatId: updated.id, avatarKey: key, avatarUrl: updated.avatarUrl, chat: updated });
    } catch (e) {}

    res.json(updated);
  } catch (e) {
    console.error('POST /chats/:id/avatar error', e?.message || e);
    res.status(500).json({ error: 'Internal error' });
  }
});

// Send message to chat via /chats/:id/messages (proxy to messages logic)
router.post('/:id/messages', upload.single('file'), async (req, res) => {
  const chatId = req.params.id;
  const { type = 'text', content, repliedTo } = req.body;
  await db.init();
  let chat = await db.getChatById(chatId);
  if (!chat) return res.status(404).json({ error: 'Chat not found' });
  if (!chat.members.includes(req.user.id)) return res.status(403).json({ error: 'Not member of chat' });

  let payload = null;
  let mentionAll = false;
  let mentionUserIds = [];
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

  // Mentions (@) are part of text message content, passed from frontend.
  // Supported shapes:
  // - content: "hello" (string) -> no mentions
  // - content: { text: "...", mentions: [{ userId }], mentionAll: true }
  if (!req.file && type === 'text') {
    const obj = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
    if (obj) {
      // mentionAll can be a boolean or represented as a special mention item
      mentionAll = obj.mentionAll === true;
      const rawMentions = Array.isArray(obj.mentions) ? obj.mentions : [];
      if (!mentionAll) {
        mentionAll = rawMentions.some(m => m && (m.type === 'all' || m.kind === 'all'));
      }

      const rawUserIds = rawMentions
        .map(m => (m && typeof m === 'object') ? m.userId : null)
        .filter(Boolean);

      mentionUserIds = Array.from(new Set(rawUserIds)).filter(uid => uid !== req.user.id);

      // Basic anti-abuse limit
      if (mentionUserIds.length > 50) {
        return res.status(400).json({ error: 'Too many mentions' });
      }

      // Mention feature is for group chat
      if ((mentionAll || mentionUserIds.length > 0) && chat.type !== 'group') {
        return res.status(400).json({ error: 'Mentions are only supported in group chats' });
      }

      // Validate mentioned users are members
      const memberSet = new Set(chat.members || []);
      for (const uid of mentionUserIds) {
        if (!memberSet.has(uid)) {
          return res.status(400).json({ error: 'Mentioned user must be a member', userId: uid });
        }
      }

      // Validate @all permission (owner/admin only)
      if (mentionAll) {
        const role = await getGroupRole(chat, req.user.id);
        if (!role.canManage) return res.status(403).json({ error: 'Only owner/admin can use @all' });
      }
    }
  }

  const messageId = generateId();
  const msg = await db.createMessage({ id: messageId, chatId, from: req.user.id, type, content: payload, repliedTo });
  try {
    const io = getIo();
    io.to(`chat:${chatId}`).emit('message.created', msg);
    emitToUsers(chat.members || [], 'message.created', msg);

    // Mention notification (socket only; no schema changes)
    if (type === 'text' && !req.file) {
      if (mentionAll) {
        const targets = (chat.members || []).filter(uid => uid !== req.user.id);
        emitToUsers(targets, 'message.mentioned', {
          chatId,
          messageId: msg.id,
          fromUser: req.user.id,
          all: true
        });
      }
      if (mentionUserIds && mentionUserIds.length > 0) {
        emitToUsers(mentionUserIds, 'message.mentioned', {
          chatId,
          messageId: msg.id,
          fromUser: req.user.id,
          mentionedUserIds: mentionUserIds
        });
      }
    }
  } catch (e) { }
  res.json(msg);
});

// GET /chats/:id - placed AFTER all /:id/* routes to avoid interception
router.get('/:id', async (req, res) => {
  await db.init();
  const chat = await db.getChatById(req.params.id);
  if (!chat || !chat.members.includes(req.user.id)) return res.status(404).json({ error: 'Chat not found' });
  attachChatAvatar(chat);
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

// PATCH /chats/:id - placed AFTER all /:id/* routes to avoid interception
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
    attachChatAvatar(updated);

    try {
      emitToUsers(updated.members || [], 'chat.updated', { chat: updated });
      emitToUsers(updated.members || [], 'chat.renamed', { chatId: updated.id, name: updated.name || null, chat: updated });
    } catch (e) {}

    res.json(updated);
  } catch (e) {
    console.error('PATCH /chats/:id error', e?.message || e);
    res.status(500).json({ error: 'Internal error' });
  }
});

// DELETE /chats/:id - dissolve group chat (owner only)
router.delete('/:id', async (req, res) => {
  try {
    await db.init();
    const chat = await loadChatAsMember(req, res);
    if (!chat) return;
    if (chat.type !== 'group') return res.status(400).json({ error: 'Only group chats can be dissolved' });
    if (chat.created_by !== req.user.id) return res.status(403).json({ error: 'Only owner can dissolve group' });

    const memberIds = Array.isArray(chat.members) ? chat.members.slice() : [];
    try {
      emitToUsers(memberIds, 'chat.dissolved', { chatId: chat.id });
      emitToUsers(memberIds, 'chat.deleted', { chatId: chat.id });
    } catch (e) {}

    await db.deleteChat(chat.id);
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /chats/:id error', e?.message || e);
    res.status(500).json({ error: 'Internal error' });
  }
});

module.exports = router;
