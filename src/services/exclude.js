const minimatch = require('./minimatch');
const config = require('../config');

function parseList(raw) {
  try {
    const arr = JSON.parse(raw || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function parseExcludes(raw) { return parseList(raw); }

function isExcluded(relPath, excludes) {
  const parts = relPath.split(/[/\\]/);
  for (const pattern of excludes) {
    if (minimatch(relPath, pattern)) return true;
    for (const part of parts) {
      if (minimatch(part, pattern)) return true;
    }
  }
  return false;
}

function withSiteExcludes(site) {
  return parseExcludes(site.excludes).length ? parseExcludes(site.excludes) : config.defaultExcludes;
}

// ===== 受保护文件（protect）：参与快照/统计，但发布与回滚不覆盖、不删除 =====
// 与 excludes 的区别：excludes 是"不参与快照/统计"，protect 是"参与但不被发布覆盖"
function withSiteProtects(site) {
  const list = site.protect_files != null
    ? parseList(typeof site.protect_files === 'string' ? site.protect_files : JSON.stringify(site.protect_files))
    : [];
  return list.length ? list : config.defaultProtects;
}

// 大小写不敏感匹配；protect 条目按文件名（不按整路径）匹配
function isProtected(relPath, protects) {
  if (!protects || !protects.length) return false;
  const lower = relPath.toLowerCase();
  const name = lower.split('/').pop();
  return protects.some(p => {
    const pat = String(p).toLowerCase();
    return lower === pat || name === pat || minimatch(lower, pat) || minimatch(name, pat);
  });
}

module.exports = { parseExcludes, parseList, isExcluded, withSiteExcludes, withSiteProtects, isProtected };