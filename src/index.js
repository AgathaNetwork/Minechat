require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');

const authRoutes = require('./routes/auth');
const chatRoutes = require('./routes/chats');
const messageRoutes = require('./routes/messages');
const usersRoutes = require('./routes/users');
const globalRoutes = require('./routes/global');
const emojiRoutes = require('./routes/emoji');
const imagesRoutes = require('./routes/images');
const infoRoutes = require('./routes/info');
const http = require('http');
const db = require('./db');
const { initSocket } = require('./socket');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

app.use('/auth', authRoutes);
app.use('/chats', chatRoutes);
app.use('/messages', messageRoutes);
app.use('/users', usersRoutes);
app.use('/global', globalRoutes);
app.use('/emoji', emojiRoutes);
app.use('/images', imagesRoutes);
app.use('/info', infoRoutes);

app.get('/me', require('./middleware/auth'), (req, res) => {
  res.json({ user: req.user });
});

const PORT = process.env.PORT || 3000;
const server = http.createServer(app);

db.init().then(() => {
  initSocket(server);
  server.listen(PORT, () => console.log(`Minechat API listening on ${PORT}`));
}).catch(err => {
  console.error('Failed to initialize DB:', err);
  process.exit(1);
});
