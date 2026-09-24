const express = require('express');
const siteService = require('../services/siteService');
const versionService = require('../services/versionService');
const lockService = require('../services/publishService');
const audit = require('../services/auditService');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const sites = siteService.listSites().map(s => {
    let stat = { fileCount: 0, totalSize: 0 };
    try { stat = siteService.statDir(s); } catch {}
    const latest = versionService.listVersions(s.id)[0] || null;
    return { ...s, ...stat, latest, locked: lockService.lockState(s.id) };
  });
  res.json({ sites });
});

router.post('/', (req, res) => {
  try {
    const site = siteService.addSite(req.body || {});
    audit.write(req.session.user.username, 'site.bind', site.id, site.root_path);
    res.json({ site });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.put('/:id', (req, res) => {
  try {
    const site = siteService.updateSite(Number(req.params.id), req.body || {});
    audit.write(req.session.user.username, 'site.update', site.id,
      JSON.stringify({ excludes: site.excludes, protect_files: site.protect_files, keep_count: site.keep_count }));
    res.json({ site });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.delete('/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    siteService.removeSite(id);
    audit.write(req.session.user.username, 'site.unbind', id, null);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/:id/browse', (req, res) => {
  try {
    const site = siteService.getSite(Number(req.params.id));
    if (!site) return res.status(404).json({ error: '站点不存在' });
    res.json(siteService.browse(site, String(req.query.path || '')));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;