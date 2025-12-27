let io = null;
const db = require('./db');
const jwt = require('jsonwebtoken');

// userId -> Set<socketId>
const userSockets = new Map();

function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader) return out;
  const parts = String(cookieHeader).split(';');
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (!k) continue;
    out[k] = decodeURIComponent(v);
  }
  return out;
}

async function resolveUserIdFromHandshake(socket) {
  // 1) Prefer explicit token in handshake auth/query
  const rawToken = socket.handshake?.auth?.token || socket.handshake?.query?.token;
  if (rawToken && typeof rawToken === 'string') {
    const token = rawToken.startsWith('Bearer ') ? rawToken.slice(7) : rawToken;
    const payload = jwt.verify(token, process.env.JWT_SECRET || 'dev_secret');
    return payload.sub;
  }

  // 2) Fallback to session cookie
  const cookies = parseCookies(socket.handshake?.headers?.cookie);
  const sessionId = cookies.minechat_session;
  if (sessionId) {
    await db.init();
    const session = await db.findSessionById(sessionId);
    if (!session) throw new Error('Invalid session');
    const expires = new Date(session.expires_at);
    if (expires.getTime() < Date.now()) {
      try { await db.deleteSession(sessionId); } catch (e) { }
      throw new Error('Session expired');
    }
    return session.user_id;
  }

  throw new Error('Missing auth');
}

function addUserSocket(userId, socketId) {
  if (!userId) return;
  const set = userSockets.get(userId) || new Set();
  set.add(socketId);
  userSockets.set(userId, set);
}

function removeUserSocket(userId, socketId) {
  if (!userId) return;
  const set = userSockets.get(userId);
  if (!set) return;
  set.delete(socketId);
  if (set.size === 0) userSockets.delete(userId);
}

function initSocket(server) {
  if (io) return io;
  const { Server } = require('socket.io');
  io = new Server(server, { cors: { origin: '*', methods: ['GET','POST'] } });

  // Authenticate socket and bind to userId
  io.use(async (socket, next) => {
    try {
      const userId = await resolveUserIdFromHandshake(socket);
      await db.init();
      const user = await db.findUserById(userId);
      if (!user) return next(new Error('User not found'));
      socket.userId = userId;
      return next();
    } catch (e) {
      return next(new Error(e?.message || 'Unauthorized'));
    }
  });

  io.on('connection', socket => {
    // Track online sockets per user
    if (socket.userId) addUserSocket(socket.userId, socket.id);

    socket.on('disconnect', () => {
      if (socket.userId) removeUserSocket(socket.userId, socket.id);
    });

    socket.on('join', chatId => {
      try { socket.join(`chat:${chatId}`); } catch (e) { }
    });

    socket.on('leave', chatId => {
      try { socket.leave(`chat:${chatId}`); } catch (e) { }
    });

    // Client can request missed messages since a timestamp
    socket.on('sync', async (payload) => {
      try {
        // payload: { chatId, since }
        const { chatId, since } = payload || {};
        if (!chatId || !since) return;
        const msgs = await db.getMessagesForChatSince(chatId, since);
        socket.emit('message.missed', { chatId, messages: msgs });
      } catch (e) { }
    });
  });

  return io;
}

function getIo() {
  if (!io) throw new Error('Socket.io not initialized');
  return io;
}

function emitToUser(userId, event, payload) {
  if (!io) return 0;
  const set = userSockets.get(userId);
  if (!set || set.size === 0) return 0;
  let sent = 0;
  for (const socketId of set) {
    try {
      io.to(socketId).emit(event, payload);
      sent += 1;
    } catch (e) { }
  }
  return sent;
}

function emitToUsers(userIds, event, payload) {
  const ids = Array.isArray(userIds) ? userIds : [];
  let total = 0;
  for (const uid of ids) {
    total += emitToUser(uid, event, payload);
  }
  return total;
}

function emitToOnlineUsers(event, payload) {
  if (!io) return 0;
  let total = 0;
  for (const uid of userSockets.keys()) {
    total += emitToUser(uid, event, payload);
  }
  return total;
}

function getOnlineUserIds() {
  return Array.from(userSockets.keys());
}

module.exports = { initSocket, getIo, emitToUser, emitToUsers, emitToOnlineUsers, getOnlineUserIds };
