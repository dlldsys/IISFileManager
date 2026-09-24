const fs = require('fs');
const path = require('path');
const db = require('../db');
const config = require('../config');
const audit = require('./auditService');

function zipPathFor(siteId, versionId) {
  return path.join(config.snapshotDir, String(siteId), versionId + '.zip');
}

function insert(site, { kind, label, user, fileCount = 0, size = 0, mode = null }) {
  const info = db.prepare(
    'INSERT INTO versions (site_id, label, zip_path, file_count, size, kind, mode, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(site.id, label || null, '', fileCount, size, kind, mode || null, user || null);
  return Number(info.lastInsertRowid);
}

function setZipPath(versionId, zipPath) {
  db.prepare('UPDATE versions SET zip_path = ? WHERE id = ?').run(zipPath, versionId);
}

function saveManifest(versionId, manifest) {
  const ins = db.prepare('INSERT OR REPLACE INTO version_files (version_id, path, size, sha256) VALUES (?, ?, ?, ?)');
  for (const f of manifest) ins.run(versionId, f.path, f.size, f.sha256);
}

function listVersions(siteId) {
  return db.prepare(
    'SELECT id, site_id, label, file_count, size, kind, mode, created_by, created_at FROM versions WHERE site_id = ? ORDER BY id DESC'
  ).all(siteId);
}

function getVersion(siteId, versionId) {
  return db.prepare('SELECT * FROM versions WHERE site_id = ? AND id = ?').get(siteId, versionId);
}

function versionFiles(versionId) {
  return db.prepare('SELECT path, size, sha256 FROM version_files WHERE version_id = ? ORDER BY path').all(versionId);
}

function diffVersions(aId, bId) {
  const A = new Map(versionFiles(aId).map(f => [f.path, f]));
  const B = new Map(versionFiles(bId).map(f => [f.path, f]));
  const added = [], modified = [], removed = [];
  for (const [p, f] of B) if (!A.has(p)) added.push({ path: p, size: f.size });
  for (const [p, f] of A) if (!B.has(p)) removed.push({ path: p, size: f.size });
  for (const [p, f] of B) {
    const old = A.get(p);
    if (old && old.sha256 !== f.sha256) modified.push({ path: p, from: old.size, to: f.size });
  }
  return { added, modified, removed };
}

// 删除版本：记录 + version_files + 快照 zip 一并清理（需在无锁时调用）；
// zip 已不在磁盘时跳过文件删除，只删数据库记录，不报错
// 设置当前版本（发布成功后 / 回滚目标）
function setCurrent(siteId, versionId) {
  db.prepare('UPDATE sites SET current_version_id = ? WHERE id = ?').run(versionId, siteId);
}

// 指向的版本被删（手动删除 / keep_count 清理）时回退：置空或改指最近一个剩余版本
function reconcileCurrent(siteId) {
  const s = db.prepare('SELECT current_version_id FROM sites WHERE id = ?').get(siteId);
  if (!s || s.current_version_id == null) return s ? s.current_version_id : null;
  if (db.prepare('SELECT id FROM versions WHERE id = ?').get(s.current_version_id)) return s.current_version_id;
  const latest = db.prepare('SELECT id FROM versions WHERE site_id = ? ORDER BY id DESC LIMIT 1').get(siteId);
  const next = latest ? latest.id : null;
  db.prepare('UPDATE sites SET current_version_id = ? WHERE id = ?').run(next, siteId);
  return next;
}

function removeVersion(siteId, versionId) {
  const v = getVersion(siteId, versionId);
  if (!v) throw Object.assign(new Error('版本不存在'), { code: 'NOTFOUND' });
  if (v.zip_path) {
    try { fs.rmSync(v.zip_path, { force: true }); } catch {}
  }
  db.prepare('DELETE FROM version_files WHERE version_id = ?').run(versionId);
  db.prepare('DELETE FROM versions WHERE id = ?').run(versionId);
  // 删除的若是当前版本 → 回退 current 指向（置空或最近剩余版本）
  reconcileCurrent(siteId);
  return v;
}

function cleanup(site, user) {
  const keep = site.keep_count || config.defaultKeep;
  const rows = db.prepare('SELECT id, zip_path FROM versions WHERE site_id = ? ORDER BY id DESC').all(site.id);
  const excess = rows.slice(keep);
  for (const r of excess) {
    // 快照 zip 已缺失时跳过文件删除，只清理记录
    if (r.zip_path) {
      try { fs.rmSync(r.zip_path, { force: true }); } catch {}
    }
    db.prepare('DELETE FROM version_files WHERE version_id = ?').run(r.id);
    db.prepare('DELETE FROM versions WHERE id = ?').run(r.id);
    audit.write(user, 'cleanup', site.id, 'removed version=' + r.id);
  }
  if (excess.length) reconcileCurrent(site.id); // 清掉的可能是 current_version_id 指向的版本
  return excess.length;
}

module.exports = { zipPathFor, insert, setZipPath, saveManifest, listVersions, getVersion, versionFiles, diffVersions, removeVersion, cleanup, setCurrent, reconcileCurrent };