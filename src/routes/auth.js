const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const audit = require('../services/auditService');
const config = require('../config');

const router = express.Router();

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'missing credentials' });
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    audit.write(username, 'login.failed', null, null);
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  req.session.user = { username: user.username };
  audit.write(user.username, 'login', null, null);
  res.json({ user: { username: user.username } });
});

router.post('/logout', (req, res) => {
  const u = req.session.user;
  req.session.destroy(() => {
    if (u) audit.write(u.username, 'logout', null, null);
    res.json({ ok: true });
  });
});

router.get('/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'unauthorized' });
  res.json({ user: req.session.user });
});

module.exports = router;