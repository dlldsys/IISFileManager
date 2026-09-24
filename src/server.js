const express = require('express');
const session = require('express-session');
const path = require('path');
const config = require('./config');
const logger = require('./logger');
const { requireAuth } = require('./middleware/auth');

const authRoutes = require('./routes/auth');
const siteRoutes = require('./routes/sites');
const fileRoutes = require('./routes/files');
const publishRoutes = require('./routes/publish');
const versionRoutes = require('./routes/versions');
const auditRoutes = require('./routes/audit');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(session({
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 12 * 3600 * 1000 }
}));

app.use('/api/auth', authRoutes);
app.use('/api/sites', siteRoutes);
app.use('/api/sites', fileRoutes);
app.use('/api/publish', publishRoutes);
app.use('/api', versionRoutes);
app.use('/api/audit', auditRoutes);

app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

app.use((err, req, res, next) => {
  logger.error({ err: err.message }, 'unhandled');
  res.status(500).json({ error: '服务器内部错误' });
});

app.listen(config.port, () => {
  logger.info({ port: config.port }, 'file-proxy started');
});