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
    // 统计只读库（绑定/发布/回滚/编辑/设置变更/手动刷新时已落库）；存量 NULL 时惰性算一次回写
    let stat;
    try { stat = siteService.ensureStats(s); } catch { stat = { fileCount: 0, totalSize: 0, statsUpdatedAt: s.stats_updated_at || null }; }
    const latest = versionService.listVersions(s.id)[0] || null;
    return {
      ...s, latest, locked: lockService.lockState(s.id),
      fileCount: stat.fileCount, totalSize: stat.totalSize,
      stats_updated_at: stat.statsUpdatedAt
    };
  });
  res.json({ sites });
});

router.post('/', (req, res) => {
  try {
    const site = siteService.addSite(req.body || {});
    // 绑定成功后立即统计一次落库，GET /sites 即可直接读库
    siteService.refreshStats(site);
    audit.write(req.session.user.username, 'site.bind', site.id, site.root_path);
    res.json({ site: siteService.getSite(site.id) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.put('/:id', (req, res) => {
  try {
    const before = siteService.getSite(Number(req.params.id));
    const site = siteService.updateSite(Number(req.params.id), req.body || {});
    audit.write(req.session.user.username, 'site.update', site.id,
      JSON.stringify({ excludes: site.excludes, protect_files: site.protect_files, keep_count: site.keep_count }));
    // excludes/protect_files 变更影响统计口径 → 重算落库（keep_count 单独变更不触发）
    const scopeChanged = before && (
      JSON.stringify(before.excludes) !== JSON.stringify(site.excludes) ||
      JSON.stringify(before.protect_files) !== JSON.stringify(site.protect_files));
    if (scopeChanged) siteService.refreshStats(site);
    res.json({ site: siteService.getSite(site.id) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// 批量追加接口（文件浏览多选 → 加入排除项 / 发布不替换）：只追加不覆盖，写审计日志
router.put('/:id/protect', (req, res) => {
  try {
    const body = req.body || {};
    const id = Number(req.params.id);
    const before = siteService.getSite(id);
    const site = siteService.appendSiteSettings(id, body);
    audit.write(req.session.user.username, 'site.update', site.id,
      JSON.stringify({ appended: { excludes: body.excludes || [], protect_files: body.protect_files || [] } }));
    const scopeChanged = before && (
      JSON.stringify(before.excludes) !== JSON.stringify(site.excludes) ||
      JSON.stringify(before.protect_files) !== JSON.stringify(site.protect_files));
    if (scopeChanged) siteService.refreshStats(site);
    res.json({ site: siteService.getSite(site.id) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// 手动刷新统计：全量重算 fileCount/totalSize 落库并返回新统计（站点卡片/详情页"刷新统计"按钮）
router.post('/:id/refresh', (req, res) => {
  try {
    const site = siteService.getSite(Number(req.params.id));
    if (!site) return res.status(404).json({ error: '站点不存在' });
    const st = siteService.refreshStats(site);
    res.json({ site: { ...siteService.getSite(site.id), fileCount: st.fileCount, totalSize: st.totalSize, stats_updated_at: st.statsUpdatedAt } });
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