const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const config = require('./config');

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.snapshotDir, { recursive: true });

// ===== 存量 WAL 迁移（必须在打开库之前完成）=====
// node:sqlite 建的库默认/曾用 WAL；node-sqlite3-wasm（Node 20 回退）不支持 WAL。
// 统一策略：两端都用 journal_mode=DELETE（单进程小应用足够）。
function migrateWalLegacy(dbPath) {
  const wal = dbPath + '-wal';
  const shm = dbPath + '-shm';
  if (!fs.existsSync(dbPath)) return;
  // 1) 残留 sidecar 是垃圾（delete 模式库不需要它们，且会让 wasm 打不开）：
  //    读 header 判断主库本就是 delete 模式（写/读版本号 1）时直接删除
  let fd = fs.openSync(dbPath, 'r+');
  try {
    const h = Buffer.alloc(24);
    fs.readSync(fd, h, 0, 24, 0);
    const isDeleteMode = h[18] === 1 && h[19] === 1;
    if (isDeleteMode) {
      fs.closeSync(fd); fd = null;
      fs.rmSync(wal, { force: true });
      fs.rmSync(shm, { force: true });
      return;
    }
    // 2) WAL 模式主库：-wal 非空说明有未合并数据 → 需 node:sqlite 回灌（Node 22+）。
    //    Node 20 没有 node:sqlite 且 wasm 打不开 WAL 库，给出明确提示。
    if (fs.existsSync(wal) && fs.statSync(wal).size > 0) {
      fs.closeSync(fd); fd = null;
      const major = Number(process.versions.node.split('.')[0]);
      if (major < 22) {
        throw new Error('data/app.db 存在未合并的 WAL 数据，请先在 Node >= 22 下启动一次服务以合并 WAL，再切换到 Node ' + process.versions.node);
      }
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(dbPath);
      db.exec('PRAGMA journal_mode = DELETE;'); // 打开即回灌 WAL，再切成 delete
      db.close();
    } else {
      // 3) WAL 头 + 空/无 sidecar：直接把 header 的写/读版本号改成 1（等价 delete 模式）
      fs.closeSync(fd); fd = null;
      const fd2 = fs.openSync(dbPath, 'r+');
      const h2 = Buffer.alloc(24);
      fs.readSync(fd2, h2, 0, 24, 0);
      h2[18] = 1; h2[19] = 1;
      fs.writeSync(fd2, h2, 0, 24, 0);
      fs.closeSync(fd2);
      fs.rmSync(wal, { force: true });
      fs.rmSync(shm, { force: true });
    }
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch {} }
  }
}
migrateWalLegacy(config.dbPath);

// node-sqlite3-wasm（Node 20）用 mkdir <db>.lock 做进程互斥；进程异常退出会残留该目录，
// 导致下次启动永久 database is locked。本服务单实例（端口绑定兜底），启动时清理残留锁。
try { fs.rmdirSync(config.dbPath + '.lock'); } catch {}

// ===== 运行时驱动切换：>=22 用内建 node:sqlite，否则回退纯 WASM =====
const useNative = typeof process.versions.node === 'string'
  && Number(process.versions.node.split('.')[0]) >= 22;

function bindArgs(args) {
  if (args.length === 0) return [];
  return args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
}

function openNative(dbPath) {
  const { DatabaseSync } = require('node:sqlite');
  const d = new DatabaseSync(dbPath);
  const cache = new Map(); // 同 SQL 复用 statement（node:sqlite 语义与原实现等价）
  return {
    prepare(sql) {
      let st = cache.get(sql);
      if (!st) { st = d.prepare(sql); cache.set(sql, st); }
      return {
        get: (...a) => { const p = bindArgs(a); return p.length ? st.get(...p) : st.get(); },
        all: (...a) => { const p = bindArgs(a); return p.length ? st.all(...p) : st.all(); },
        run: (...a) => { const p = bindArgs(a); return p.length ? st.run(...p) : st.run(); },
        finalize: () => {}
      };
    },
    exec: sql => d.exec(sql),
    close: () => d.close()
  };
}

function openWasm(dbPath) {
  const { Database } = require('node-sqlite3-wasm');
  const d = new Database(dbPath);
  const cache = new Map(); // 按 SQL 缓存并复用，避免 wasm Statement 不被 GC 导致泄漏
  return {
    prepare(sql) {
      let st = cache.get(sql);
      if (!st) { st = d.prepare(sql); cache.set(sql, st); }
      return {
        get: (...a) => { const p = bindArgs(a); return p.length ? st.get(p) : st.get(); },
        all: (...a) => { const p = bindArgs(a); return p.length ? st.all(p) : st.all(); },
        run: (...a) => { const p = bindArgs(a); return p.length ? st.run(p) : st.run(); },
        finalize: () => {}
      };
    },
    exec: sql => d.exec(sql),
    close: () => { for (const st of cache.values()) st.finalize(); d.close(); }
  };
}

const db = (useNative ? openNative : openWasm)(config.dbPath);
// 两端统一：不用 WAL（wasm 不支持；单进程场景 DELETE 够用）
db.exec('PRAGMA journal_mode = DELETE;');

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
// 回滚不建新版本：sites.current_version_id 指向当前生效的版本
if (!hasColumn('sites', 'current_version_id')) {
  db.exec('ALTER TABLE sites ADD COLUMN current_version_id INTEGER');
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