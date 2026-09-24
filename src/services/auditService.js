const db = require('../db');
const logger = require('../logger');

function write(username, action, siteId, detail) {
  db.prepare('INSERT INTO audit_logs (username, action, site_id, detail) VALUES (?, ?, ?, ?)').run(
    username || null,
    action,
    siteId || null,
    detail ? String(detail).slice(0, 2000) : null
  );
  logger.info({ action, siteId, user: username }, 'audit');
}

function list({ siteId, action, limit = 100, offset = 0 }) {
  const where = [];
  const params = [];
  if (siteId) { where.push('site_id = ?'); params.push(siteId); }
  if (action) { where.push('action = ?'); params.push(action); }
  const sql = 'SELECT * FROM audit_logs' +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY id DESC LIMIT ? OFFSET ?';
  params.push(Math.min(Number(limit) || 100, 500), Number(offset) || 0);
  return db.prepare(sql).all(...params);
}

module.exports = { write, list };