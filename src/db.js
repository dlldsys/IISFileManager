const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');
const config = require('./config');

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.snapshotDir, { recursive: true });

const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  root_path TEXT UNIQUE NOT NULL,
  excludes TEXT NOT NULL DEFAULT '[]',
  keep_count INTEGER NOT NULL DEFAULT ${config.defaultKeep},
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL,
  label TEXT,
  zip_path TEXT NOT NULL,
  file_count INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL,
  mode TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS version_files (
  version_id INTEGER NOT NULL,
  path TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  PRIMARY KEY (version_id, path)
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT,
  action TEXT NOT NULL,
  site_id INTEGER,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_versions_site ON versions(site_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_site ON audit_logs(site_id, id DESC);
`);

// ===== 旧库迁移：新增列用 PRAGMA 探测，避免重复 ALTER =====
function hasColumn(table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);
}
if (!hasColumn('sites', 'protect_files')) {
  db.exec(`ALTER TABLE sites ADD COLUMN protect_files TEXT NOT NULL DEFAULT '["web.config","Web.config"]'`);
}
if (!hasColumn('versions', 'mode')) {
  db.exec('ALTER TABLE versions ADD COLUMN mode TEXT');
}

if (!db.prepare('SELECT id FROM users WHERE username = ?').get(config.adminUser)) {
  db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
    .run(config.adminUser, bcrypt.hashSync(config.adminPass, 10));
}

// zip_path 按确定规则 snapshotDir/<site_id>/<id>.zip 落盘，回填历史空值
const orphans = db.prepare('SELECT id, site_id FROM versions WHERE zip_path = ?').all('');
for (const v of orphans) {
  const p = path.join(config.snapshotDir, String(v.site_id), v.id + '.zip');
  if (fs.existsSync(p)) db.prepare('UPDATE versions SET zip_path = ? WHERE id = ?').run(p, v.id);
}

module.exports = db;