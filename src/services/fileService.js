const fs = require('fs');
const path = require('path');
const config = require('../config');
const { resolveIn } = require('./siteService');

const TEXT_EXT = new Set(['.txt', '.js', '.ts', '.jsx', '.tsx', '.vue', '.html', '.htm', '.css', '.scss',
  '.json', '.xml', '.yml', '.yaml', '.md', '.config', '.cs', '.cshtml', '.aspx', '.asp', '.sql',
  '.env', '.ini', '.bat', '.cmd', '.ps1', '.sh', '.log', '.csv']);

function isText(file) {
  return TEXT_EXT.has(path.extname(file).toLowerCase());
}

function read(site, rel) {
  const abs = resolveIn(site, rel);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error('文件不存在');
  const st = fs.statSync(abs);
  if (st.size > config.maxEditSize) throw new Error('文件超过编辑大小限制 (2MB)');
  if (!isText(abs)) throw new Error('非文本文件，仅支持下载');
  return { path: rel, content: fs.readFileSync(abs, 'utf8'), size: st.size, mtime: st.mtime.toISOString() };
}

function save(site, rel, content) {
  if (typeof content !== 'string') throw new Error('内容无效');
  if (Buffer.byteLength(content, 'utf8') > config.maxEditSize) throw new Error('内容超过编辑大小限制 (2MB)');
  const abs = resolveIn(site, rel);
  if (!isText(abs)) throw new Error('非文本文件，不支持在线编辑');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const had = fs.existsSync(abs);
  fs.writeFileSync(abs, content, 'utf8');
  return { path: rel, existed: had };
}

module.exports = { read, save, isText };