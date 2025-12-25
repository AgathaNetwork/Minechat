let io = null;
const db = require('./db');

function initSocket(server) {
  if (io) return io;
  const { Server } = require('socket.io');
  io = new Server(server, { cors: { origin: '*', methods: ['GET','POST'] } });

  io.on('connection', socket => {
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

module.exports = { initSocket, getIo };
