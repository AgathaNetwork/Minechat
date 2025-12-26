const express = require('express');
const db = require('../db');

const router = express.Router();

// GET /users - list all users (id, username)
router.get('/', async (req, res) => {
  try {
    await db.init();
    const users = await db.getAllUsers();
    res.json(users || []);
  } catch (e) {
    console.error('GET /users error', e?.message || e);
    res.status(500).json({ error: 'Internal error' });
  }
});

// GET /users/:id - return minimal public user info (id, username)
router.get('/:id', async (req, res) => {
  try {
    await db.init();
    const user = await db.findUserById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ id: user.id, username: user.username });
  } catch (e) {
    console.error('GET /users/:id error', e?.message || e);
    res.status(500).json({ error: 'Internal error' });
  }
});

module.exports = router;
