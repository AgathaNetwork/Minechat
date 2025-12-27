const express = require('express');
const { generateId } = require('../utils/id');
const db = require('../db');
const auth = require('../middleware/auth');
const { getIo, emitToOnlineUsers } = require('../socket');

const router = express.Router();

router.use(auth);

// GET /global/messages - list global messages
router.get('/messages', async (req, res) => {
  try {
    await db.init();
    const since = req.query.since;
    const before = req.query.before;
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '50', 10)));
    let msgs;
    if (since) msgs = await db.getGlobalMessagesSince(since);
    else if (before) msgs = await db.getGlobalMessagesBefore(before, limit);
    else msgs = await db.getLatestGlobalMessages(limit);
    res.json(msgs);
  } catch (e) {
    console.error('GET /global/messages error', e?.message || e);
    res.status(500).json({ error: 'Internal error' });
  }
});

// POST /global/messages - send a plain text global message
router.post('/messages', async (req, res) => {
  try {
    await db.init();
    const { content } = req.body;
    if (!content || typeof content !== 'string') return res.status(400).json({ error: 'content (string) required' });
    // only text allowed currently; reserve 'content' as structured JSON for future types
    const msg = await db.createGlobalMessage({ id: generateId(), from: req.user.id, type: 'text', content: { text: content } });
    try {
      getIo().emit('global.message.created', msg);
      // For user-level realtime: push to each online user's socket
      emitToOnlineUsers('global.message.created', msg);
    } catch (e) { }
    res.json(msg);
  } catch (e) {
    console.error('POST /global/messages error', e?.message || e);
    res.status(500).json({ error: 'Internal error' });
  }
});

module.exports = router;
