const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const os = require('os');
const siteService = require('../services/siteService');
const publishService = require('../services/publishService');
const { requireAuth } = require('../middleware/auth');
const config = require('../config');

const router = express.Router();
router.use(requireAuth);

const upload = multer({
  dest: path.join(os.tmpdir(), 'fp-uploads'),
  limits: { fileSize: config.maxUploadSize }
});

function getSite(req, res) {
  const site = siteService.getSite(Number(req.params.id));
  if (!site) { res.status(404).json({ error: '站点不存在' }); return null; }
  return site;
}

// 阶段一：上传 zip，不替换文件；返回差异预览 + preview token（30 分钟有效）
router.post('/:id', upload.single('file'), async (req, res) => {
  const site = getSite(req, res);
  if (!site) { if (req.file) fs.rmSync(req.file.path, { force: true }); return; }
  if (!req.file) return res.status(400).json({ error: '缺少 zip 文件' });
  try {
    const result = await publishService.preview(site, req.file.path, {
      label: req.body.label || null,
      mode: req.body.mode || 'full',
      user: req.session.user.username
    });
    res.json(result);
  } catch (e) {
    fs.rmSync(req.file.path, { force: true });
    res.status(400).json({ error: e.message });
  }
});

// 阶段二：凭 preview token 确认发布（互斥锁在此阶段获取）
router.post('/:id/confirm', async (req, res) => {
  try {
    const site = getSite(req, res);
    if (!site) return;
    const token = (req.body && req.body.token) || '';
    if (!token) return res.status(400).json({ error: '缺少预览 token' });
    const result = await publishService.confirm(site, token, { user: req.session.user.username });
    res.json(result);
  } catch (e) {
    const code = e.code === 'LOCKED' ? 409 : e.code === 'NOTFOUND' ? 404 : 400;
    res.status(code).json({ error: e.message });
  }
});

// 取消预览：删除 token 并清理临时 zip
router.post('/:id/cancel', (req, res) => {
  const site = getSite(req, res);
  if (!site) return;
  const token = (req.body && req.body.token) || '';
  res.json({ ok: publishService.cancelPreview(site, token) });
});

module.exports = router;