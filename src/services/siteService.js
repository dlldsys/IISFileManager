const fs = require('fs');
const path = require('path');
const db = require('../db');
const config = require('../config');

function listSites() {
  return db.prepare('SELECT * FROM sites ORDER BY id').all().map(normalizeSite);
}

function normalizeSite(s) {
  if (!s) return s;
  s.excludes = JSON.parse(s.excludes || '[]');
  s.protect_files = JSON.parse(s.protect_files || '[]');
  return s;
}

function getSite(id) {
  const s = db.prepare('SELECT * FROM sites WHERE id = ?').get(id);
  return normalizeSite(s);
}

function addSite({ name, root_path, excludes, keep_count, protect_files }) {
  const abs = path.resolve(root_path);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error('目录不存在: ' + abs);
  const info = db.prepare('INSERT INTO sites (name, root_path, excludes, keep_count, protect_files) VALUES (?, ?, ?, ?, ?)')
    .run(name.trim(), abs, JSON.stringify(excludes || []), keep_count || 10, JSON.stringify(protect_files || config.defaultProtects));
  return getSite(info.lastInsertRowid);
}

function updateSite(id, { name, excludes, keep_count, protect_files }) {
  const s = getSite(id);
  if (!s) throw new Error('站点不存在');
  let rawExcludes = s.excludes;
  if (excludes != null) rawExcludes = JSON.stringify(excludes);
  else if (Array.isArray(rawExcludes)) rawExcludes = JSON.stringify(rawExcludes);
  let rawProtect = JSON.stringify(s.protect_files || []);
  if (protect_files != null) {
    // 置空 → 回落默认保护文件（含 web.config），与运行时 withSiteProtects 兜底行为一致
    rawProtect = JSON.stringify(protect_files.length ? protect_files : config.defaultProtects);
  }
  db.prepare('UPDATE sites SET name = ?, excludes = ?, keep_count = ?, protect_files = ? WHERE id = ?').run(
    name != null ? name : s.name,
    rawExcludes,
    keep_count != null ? keep_count : s.keep_count,
    rawProtect,
    id
  );
  return getSite(id);
}

// 批量追加排除项 / 发布不替换文件（文件多选批量设置）：只追加、去重（大小写不敏感），不覆盖原值
function appendSiteSettings(id, { excludes, protect_files }) {
  const s = getSite(id);
  if (!s) throw new Error('站点不存在');
  const merge = (base, extra) => {
    const out = (base || []).slice();
    for (const raw of extra || []) {
      const v = String(raw == null ? '' : raw).trim();
      if (!v) continue;
      if (!out.some(x => String(x).toLowerCase() === v.toLowerCase())) out.push(v);
    }
    return out;
  };
  const patch = {};
  if (excludes != null) patch.excludes = merge(s.excludes, excludes);
  if (protect_files != null) patch.protect_files = merge(s.protect_files, protect_files);
  return updateSite(id, patch);
}

function removeSite(id) {
  db.prepare('DELETE FROM sites WHERE id = ?').run(id);
}

function statDir(site) {
  const { walk } = require('./archiveService');
  const { withSiteExcludes } = require('./exclude');
  const files = walk(site.root_path, withSiteExcludes(site));
  return { fileCount: files.length, totalSize: files.reduce((a, f) => a + f.size, 0) };
}

// 统计重算并落库（GET /sites 只读缓存，绑定/发布/回滚/编辑/设置变更/手动刷新时调用）
function refreshStats(site) {
  let st;
  try { st = statDir(site); } catch { st = { fileCount: 0, totalSize: 0 }; }
  const at = new Date().toISOString();
  db.prepare('UPDATE sites SET file_count = ?, total_size = ?, stats_updated_at = ? WHERE id = ?')
    .run(st.fileCount, st.totalSize, at, site.id);
  return { ...st, statsUpdatedAt: at };
}

// 发布/回滚等已有清单（manifest）的场景：直接复用结果落库，避免重复遍历磁盘
function saveStats(siteId, { fileCount, totalSize }) {
  const at = new Date().toISOString();
  db.prepare('UPDATE sites SET file_count = ?, total_size = ?, stats_updated_at = ? WHERE id = ?')
    .run(fileCount, totalSize, at, siteId);
  return { fileCount, totalSize, statsUpdatedAt: at };
}

// 存量站点 stats 为 NULL 的一次性兜底：首次读到时算一次并回写
function ensureStats(site) {
  if (site.stats_updated_at != null) {
    return { fileCount: site.file_count || 0, totalSize: site.total_size || 0, statsUpdatedAt: site.stats_updated_at };
  }
  const st = refreshStats(site);
  site.file_count = st.fileCount;
  site.total_size = st.totalSize;
  site.stats_updated_at = st.statsUpdatedAt;
  return st;
}

function resolveIn(site, rel) {
  const abs = path.resolve(site.root_path, rel || '');
  const root = path.resolve(site.root_path);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('路径越界');
  return abs;
}

function browse(site, rel) {
  const abs = resolveIn(site, rel);
  if (!fs.existsSync(abs)) return { path: rel || '', dirs: [], files: [] };
  const entries = fs.readdirSync(abs, { withFileTypes: true });
  const dirs = [], files = [];
  for (const e of entries) {
    const childRel = (rel ? rel + '/' : '') + e.name;
    if (e.isDirectory()) dirs.push({ name: e.name, path: childRel });
    else {
      const st = fs.statSync(path.join(abs, e.name));
      files.push({ name: e.name, path: childRel, size: st.size, mtime: st.mtime.toISOString() });
    }
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));
  return { path: rel || '', dirs, files };
}

module.exports = {
  listSites, getSite, addSite, updateSite, appendSiteSettings, removeSite,
  statDir, refreshStats, saveStats, ensureStats, browse, resolveIn
};