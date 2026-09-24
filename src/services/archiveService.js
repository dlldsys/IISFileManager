const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const archiver = require('archiver');
const AdmZip = require('adm-zip');
const { isExcluded, isProtected } = require('./exclude');

function walk(root, excludes) {
  const out = [];
  (function rec(dir, rel) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (isExcluded(r, excludes)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) rec(abs, r);
      else if (e.isFile()) {
        const st = fs.statSync(abs);
        out.push({ rel: r, abs, size: st.size });
      }
    }
  })(root, '');
  return out;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', d => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}

function zipDir(root, excludes, zipPath) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(zipPath), { recursive: true });
    const files = walk(root, excludes);
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 6 } });
    output.on('close', () => resolve({ fileCount: files.length, size: archive.pointer() }));
    archive.on('error', reject);
    archive.pipe(output);
    for (const f of files) archive.file(f.abs, { name: f.rel });
    archive.finalize();
  });
}

function manifestOf(root, excludes) {
  const files = walk(root, excludes);
  return Promise.all(files.map(async f => ({
    path: f.rel, size: f.size, sha256: await sha256File(f.abs)
  })));
}

function safeExtract(zipPath, destDir) {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  const destRoot = path.resolve(destDir);
  for (const e of entries) {
    const target = path.resolve(destDir, e.entryName);
    if (!target.startsWith(destRoot + path.sep) && target !== destRoot) {
      throw new Error('zip entry escapes destination: ' + e.entryName);
    }
  }
  fs.mkdirSync(destDir, { recursive: true });
  zip.extractAllTo(destDir, true);
  // flatten single top-level folder (common when zipping a directory)
  const top = fs.readdirSync(destDir);
  if (top.length === 1) {
    const only = path.join(destDir, top[0]);
    if (fs.statSync(only).isDirectory()) {
      for (const item of fs.readdirSync(only)) {
        fs.renameSync(path.join(only, item), path.join(destDir, item));
      }
      fs.rmdirSync(only);
    }
  }
}

// ===== 目录替换三种语义 =====
// 共同规则：excludes 文件不处理（站点原样保留）；protect 文件永不覆盖、永不删除。
function copyEntries(srcDir, destDir, { protects }) {
  for (const f of walk(srcDir, [])) {
    if (isProtected(f.rel, protects)) continue; // zip 里含 web.config 等受保护文件 → 忽略
    const target = path.join(destDir, f.rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(f.abs, target);
  }
}

function removeUnwanted(destDir, { excludes, protects }) {
  for (const f of walk(destDir, [])) {
    if (isExcluded(f.rel, excludes)) continue;
    if (isProtected(f.rel, protects)) continue;
    try { fs.unlinkSync(f.abs); } catch {}
  }
}

// 全量发布 / 彻底还原回滚：先删除站点非排除非保护文件，再整包覆盖（跳过保护文件）
function replaceDir(srcDir, destDir, excludes, protects = []) {
  fs.mkdirSync(destDir, { recursive: true });
  removeUnwanted(destDir, { excludes, protects });
  copyEntries(srcDir, destDir, { protects });
}

// 增量发布：只新增/覆盖同路径文件，不删除站点上多余的文件
function mergeDir(srcDir, destDir, excludes, protects = []) {
  fs.mkdirSync(destDir, { recursive: true });
  copyEntries(srcDir, destDir, { protects });
}

module.exports = { walk, zipDir, manifestOf, safeExtract, replaceDir, mergeDir, sha256File };