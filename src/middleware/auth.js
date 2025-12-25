const jwt = require('jsonwebtoken');
const db = require('../db');

module.exports = async function (req, res, next) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    const token = auth.slice(7);
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET || 'dev_secret');
      await db.init();
      const user = await db.findUserById(payload.sub);
      if (!user) return res.status(401).json({ error: 'User not found' });
      req.user = user;
      return next();
    } catch (e) {
      return res.status(401).json({ error: 'Invalid token' });
    }
  }

  // Fallback: try session cookie
  const sessionId = req.cookies && req.cookies.minechat_session;
  if (sessionId) {
    try {
      await db.init();
      const session = await db.findSessionById(sessionId);
      if (!session) return res.status(401).json({ error: 'Invalid session' });
      const expires = new Date(session.expires_at);
      if (expires.getTime() < Date.now()) {
        // session expired - delete it
        await db.deleteSession(sessionId);
        return res.status(401).json({ error: 'Session expired' });
      }
      const user = await db.findUserById(session.user_id);
      if (!user) return res.status(401).json({ error: 'User not found' });
      req.user = user;
      return next();
    } catch (e) {
      return res.status(401).json({ error: 'Invalid session' });
    }
  }

  return res.status(401).json({ error: 'Missing auth' });
};
