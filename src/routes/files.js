const express = require('express');
const siteService = require('../services/siteService');
const fileService = require('../services/fileService');
const audit = require('../services/auditService');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

function mustSite(req, res) {
  const site = siteService.getSite(Number(req.params.id));
  if (!site) { res.status(404).json({ error: '站点不存在' }); return null; }
  return site;
}

router.get('/:id/file', (req, res) => {
  try {
    const site = mustSite(req, res); if (!site) return;
    res.json(fileService.read(site, String(req.query.path || '')));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/:id/file/download', (req, res) => {
  try {
    const site = mustSite(req, res); if (!site) return;
    const abs = siteService.resolveIn(site, String(req.query.path || ''));
    if (!require('fs').existsSync(abs)) return res.status(404).json({ error: '文件不存在' });
    res.download(abs);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.put('/:id/file', (req, res) => {
  try {
    const site = mustSite(req, res); if (!site) return;
    const r = fileService.save(site, req.body.path, req.body.content);
    audit.write(req.session.user.username, 'file.save', site.id, r.path);
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;