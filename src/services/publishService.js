const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { safeExtract, replaceDir, mergeDir, zipDir, manifestOf } = require('./archiveService');
const versionService = require('./versionService');
const { withSiteExcludes, withSiteProtects } = require('./exclude');
const audit = require('./auditService');

const locks = new Map();

function tryLock(siteId, user) {
  if (locks.has(siteId)) return false;
  locks.set(siteId, { user, at: new Date().toISOString() });
  return true;
}
function unlock(siteId) { locks.delete(siteId); }
function lockState(siteId) { return locks.get(siteId) || null; }

function db_setSize(id, size) {
  const db = require('../db');
  db.prepare('UPDATE versions SET size = ? WHERE id = ?').run(size, id);
}

async function snapshotCurrent(site, { kind, label, user }) {
  const excludes = withSiteExcludes(site);
  const manifest = await manifestOf(site.root_path, excludes);
  if (!manifest.length) return null;
  const id = versionService.insert(site, {
    kind, label, user, fileCount: manifest.length, size: 0
  });
  const zipFile = versionService.zipPathFor(site.id, id);
  fs.mkdirSync(path.dirname(zipFile), { recursive: true });
  const { size } = await zipDir(site.root_path, excludes, zipFile);
  db_setSize(id, size);
  versionService.setZipPath(id, zipFile);
  versionService.saveManifest(id, manifest);
  audit.write(user, 'snapshot.' + kind, site.id, 'version=' + id + ' files=' + manifest.length);
  return id;
}

// 发布模式：incremental=增量（只新增/覆盖，不删除站点多余文件）；full=全量（删除后替换）；缺省 full 保持旧行为
function normalizeMode(mode) { return mode === 'incremental' ? 'incremental' : 'full'; }

async function publish(site, zipFile, { label, user, mode }) {
  const m = normalizeMode(mode);
  if (!tryLock(site.id, user)) throw Object.assign(new Error('该站点正在发布/回滚中'), { code: 'LOCKED' });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-'));
  try {
    const snapshotId = await snapshotCurrent(site, { kind: 'snapshot', label: '发布前旧版备份', user });
    safeExtract(zipFile, path.join(tmp, 'extract'));
    const excludes = withSiteExcludes(site);
    const protects = withSiteProtects(site);
    if (m === 'incremental') mergeDir(path.join(tmp, 'extract'), site.root_path, excludes, protects);
    else replaceDir(path.join(tmp, 'extract'), site.root_path, excludes, protects);
    const manifest = await manifestOf(site.root_path, excludes);
    const vid = versionService.insert(site, { kind: 'publish', label: label || null, user, fileCount: manifest.length, size: 0, mode: m });
    const zipOut = versionService.zipPathFor(site.id, vid);
    fs.mkdirSync(path.dirname(zipOut), { recursive: true });
    const { size } = await zipDir(site.root_path, excludes, zipOut);
    db_setSize(vid, size);
    versionService.setZipPath(vid, zipOut);
    versionService.saveManifest(vid, manifest);
    versionService.cleanup(site, user);
    audit.write(user, 'publish', site.id, 'version=' + vid + ' snapshot=' + snapshotId + ' mode=' + m);
    return { versionId: vid, snapshotId, mode: m };
  } finally {
    unlock(site.id);
    fs.rmSync(tmp, { recursive: true, force: true });
    try { fs.rmSync(zipFile, { force: true }); } catch {}
  }
}

// 回滚 = 彻底还原：先快照当前，然后清空站点目录（保留保护文件与排除文件），
// 再把目标版本 zip 的全部内容解压回去（保护文件仍跳过），使非保护、非排除内容与该历史版本完全一致。
async function rollback(site, versionId, { user }) {
  const ver = versionService.getVersion(site.id, versionId);
  if (!ver) throw Object.assign(new Error('版本不存在'), { code: 'NOTFOUND' });
  if (!fs.existsSync(ver.zip_path)) throw Object.assign(new Error('版本快照 zip 缺失，无法回滚'), { code: 'BADZIP' });
  if (!tryLock(site.id, user)) throw Object.assign(new Error('该站点正在发布/回滚中'), { code: 'LOCKED' });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-'));
  try {
    await snapshotCurrent(site, { kind: 'snapshot', label: '回滚前旧版备份', user });
    safeExtract(ver.zip_path, path.join(tmp, 'extract'));
    const excludes = withSiteExcludes(site);
    const protects = withSiteProtects(site);
    replaceDir(path.join(tmp, 'extract'), site.root_path, excludes, protects);
    const manifest = await manifestOf(site.root_path, excludes);
    const vid = versionService.insert(site, { kind: 'rollback', label: '回滚到 v' + versionId, user, fileCount: manifest.length, size: 0, mode: 'full' });
    const zipOut = versionService.zipPathFor(site.id, vid);
    fs.mkdirSync(path.dirname(zipOut), { recursive: true });
    const { size } = await zipDir(site.root_path, excludes, zipOut);
    db_setSize(vid, size);
    versionService.setZipPath(vid, zipOut);
    versionService.saveManifest(vid, manifest);
    versionService.cleanup(site, user);
    audit.write(user, 'rollback', site.id, 'to=' + versionId + ' new=' + vid);
    return { versionId: vid };
  } finally {
    unlock(site.id);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ===== 预发布（两阶段发布的第一阶段）=====
const previews = new Map(); // token -> { token, siteId, zipFile, label, user, createdAt, expiresAt }
const PREVIEW_TTL_MS = 30 * 60 * 1000;

function purgeExpiredPreviews() {
  const now = Date.now();
  for (const [token, p] of previews) {
    if (now >= p.expiresAt) {
      previews.delete(token);
      try { fs.rmSync(p.zipFile, { force: true }); } catch {}
    }
  }
}

// 解压 zip 到临时目录，计算清单差异（不触碰站点目录），返回 preview token
async function preview(site, zipFile, { label, user, mode }) {
  const m = normalizeMode(mode);
  const excludes = withSiteExcludes(site);
  const protects = withSiteProtects(site);
  const { isProtected } = require('./exclude');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-pv-'));
  try {
    safeExtract(zipFile, path.join(tmp, 'extract'));
    const current = await manifestOf(site.root_path, excludes);
    const incomingRaw = await manifestOf(path.join(tmp, 'extract'), excludes);
    // zip 中的受保护文件不参与发布，从 incoming 中剔除并单列
    const skipped = [];
    const incoming = [];
    for (const f of incomingRaw) {
      if (isProtected(f.path, protects)) skipped.push({ path: f.path, note: '已跳过-受保护' });
      else incoming.push(f);
    }
    const cur = new Map(current.filter(f => !isProtected(f.path, protects)).map(f => [f.path, f]));
    const inc = new Map(incoming.map(f => [f.path, f]));
    const added = [], modified = [], removed = [];
    for (const [p, f] of inc) if (!cur.has(p)) added.push({ path: p, size: f.size });
    for (const [p, f] of cur) if (!inc.has(p)) removed.push({ path: p, size: f.size, note: m === 'incremental' ? '增量不删除' : '' });
    for (const [p, f] of inc) {
      const old = cur.get(p);
      if (old && old.sha256 !== f.sha256) modified.push({ path: p, from: old.size, to: f.size });
    }
    const byPath = (a, b) => a.path.localeCompare(b.path);
    added.sort(byPath); modified.sort(byPath); removed.sort(byPath); skipped.sort(byPath);
    purgeExpiredPreviews();
    const token = crypto.randomBytes(16).toString('hex');
    const expiresAt = Date.now() + PREVIEW_TTL_MS;
    previews.set(token, { token, siteId: site.id, zipFile, label: label || null, mode: m, user, createdAt: Date.now(), expiresAt });
    return {
      token, added, modified, removed, skipped, mode: m,
      currentCount: current.length, incomingCount: incoming.length,
      expiresAt: new Date(expiresAt).toISOString()
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// 凭 token 确认发布：校验后走 publish（内部获取互斥锁），成功删除 token
async function confirm(site, token, { user }) {
  purgeExpiredPreviews();
  const p = token && previews.get(token);
  if (!p || p.siteId !== site.id) {
    throw Object.assign(new Error('预览不存在或已过期，请重新上传'), { code: 'NOTFOUND' });
  }
  try {
    const r = await publish(site, p.zipFile, { label: p.label, mode: p.mode, user });
    previews.delete(token);
    return r;
  } catch (e) {
    // LOCKED 时 publish 在加锁前抛出、zip 未被删除，保留 token 供重试
    if (e.code !== 'LOCKED') previews.delete(token);
    throw e;
  }
}

// 取消预览：删除 token 并清理临时 zip
function cancelPreview(site, token) {
  purgeExpiredPreviews();
  const p = token && previews.get(token);
  if (!p || p.siteId !== site.id) return false;
  previews.delete(token);
  try { fs.rmSync(p.zipFile, { force: true }); } catch {}
  return true;
}

module.exports = { publish, rollback, preview, confirm, cancelPreview, tryLock, unlock, lockState };