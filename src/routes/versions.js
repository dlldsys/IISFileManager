const express = require('express');
const fs = require('fs');
const siteService = require('../services/siteService');
const versionService = require('../services/versionService');
const publishService = require('../services/publishService');
const audit = require('../services/auditService');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/sites/:id/versions', (req, res) => {
  const site = siteService.getSite(Number(req.params.id));
  if (!site) return res.status(404).json({ error: '站点不存在' });
  res.json({ versions: versionService.listVersions(site.id), locked: publishService.lockState(site.id) });
});

router.get('/sites/:id/versions/:vid/files', (req, res) => {
  const site = siteService.getSite(Number(req.params.id));
  if (!site) return res.status(404).json({ error: '站点不存在' });
  res.json({ files: versionService.versionFiles(Number(req.params.vid)) });
});

router.get('/sites/:id/versions/:vid/download', (req, res) => {
  const site = siteService.getSite(Number(req.params.id));
  if (!site) return res.status(404).json({ error: '站点不存在' });
  const v = versionService.getVersion(site.id, Number(req.params.vid));
  if (!v || !fs.existsSync(v.zip_path)) return res.status(404).json({ error: '快照不存在' });
  res.download(v.zip_path, 'site' + site.id + '-v' + v.id + '.zip');
});

router.get('/sites/:id/diff', (req, res) => {
  const site = siteService.getSite(Number(req.params.id));
  if (!site) return res.status(404).json({ error: '站点不存在' });
  const a = Number(req.query.a), b = Number(req.query.b);
  if (!a || !b) return res.status(400).json({ error: '缺少对比版本' });
  if (!versionService.getVersion(site.id, a) || !versionService.getVersion(site.id, b))
    return res.status(404).json({ error: '版本不存在' });
  res.json(versionService.diffVersions(a, b));
});

router.post('/sites/:id/rollback', async (req, res) => {
  try {
    const site = siteService.getSite(Number(req.params.id));
    if (!site) return res.status(404).json({ error: '站点不存在' });
    const r = await publishService.rollback(site, Number(req.body.versionId), { user: req.session.user.username });
    res.json(r);
  } catch (e) {
    res.status(e.code === 'LOCKED' ? 409 : 400).json({ error: e.message });
  }
});

// 删除版本：记录 + version_files + 快照 zip；锁定期禁止；写审计日志
router.delete('/sites/:id/versions/:vid', (req, res) => {
  try {
    const site = siteService.getSite(Number(req.params.id));
    if (!site) return res.status(404).json({ error: '站点不存在' });
    if (publishService.lockState(site.id))
      return res.status(409).json({ error: '该站点正在发布/回滚中，禁止删除版本' });
    const v = versionService.removeVersion(site.id, Number(req.params.vid));
    audit.write(req.session.user.username, 'version.delete', site.id,
      'version=' + v.id + ' latest=' + (versionService.listVersions(site.id)[0] || {}).id);
    res.json({ ok: true, versionId: v.id });
  } catch (e) {
    res.status(e.code === 'NOTFOUND' ? 404 : 400).json({ error: e.message });
  }
});

module.exports = router;