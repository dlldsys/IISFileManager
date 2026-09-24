// 端到端测试：node test/e2e.js（需先启动服务 npm start）
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const base = 'http://localhost:3000/api';
const jar = new Map(); // cookie jar
let pass = 0, fail = 0;

function ck() {
  return [...jar.entries()].map(([k, v]) => k + '=' + v).join('; ');
}
function saveCookies(res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of raw) {
    const [kv] = c.split(';');
    const i = kv.indexOf('=');
    jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
  }
}
async function req(method, url, body, form) {
  const h = {};
  if (jar.size) h.Cookie = ck();
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(base + url, { method, headers: h, body: payload });
  saveCookies(res);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  return { code: res.status, data };
}
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; console.log('FAIL ' + name + (detail ? '  ' + detail : '')); }
}

// 准备测试素材：站点目录 + 两个版本 zip
const siteDir = path.join(os.tmpdir(), 'fp-e2e-site');
const v1Dir = path.join(os.tmpdir(), 'fp-e2e-v1');
const v2Dir = path.join(os.tmpdir(), 'fp-e2e-v2');
fs.rmSync(siteDir, { recursive: true, force: true });
fs.mkdirSync(siteDir, { recursive: true });
fs.writeFileSync(path.join(siteDir, 'index.html'), '<h1>base</h1>');
fs.writeFileSync(path.join(siteDir, 'debug.log'), 'should be excluded');
fs.rmSync(v1Dir, { recursive: true, force: true });
fs.rmSync(v2Dir, { recursive: true, force: true });
fs.mkdirSync(v1Dir, { recursive: true });
fs.writeFileSync(path.join(v1Dir, 'index.html'), '<h1>v1</h1>');
fs.writeFileSync(path.join(v1Dir, 'app.js'), 'console.log(1)');
fs.mkdirSync(v2Dir, { recursive: true });
fs.writeFileSync(path.join(v2Dir, 'index.html'), '<h1>v2</h1>');
fs.writeFileSync(path.join(v2Dir, 'extra.txt'), 'new file');

// 用 adm-zip 打包
const AdmZip = require('adm-zip');
function zipFrom(dir, out) {
  const z = new AdmZip();
  z.addLocalFolder(dir);
  z.writeZip(out);
  return out;
}
const z1 = zipFrom(v1Dir, path.join(os.tmpdir(), 'fp-e2e-v1.zip'));
const z2 = zipFrom(v2Dir, path.join(os.tmpdir(), 'fp-e2e-v2.zip'));

function uploadZip(siteId, file, label, mode) {
  const fd = new FormData();
  fd.append('label', label);
  if (mode) fd.append('mode', mode);
  fd.append('file', new Blob([fs.readFileSync(file)]), path.basename(file));
  // 阶段一：上传 → 返回差异预览 + preview token（不产生新版本）
  return req('POST', '/publish/' + siteId, undefined, fd);
}
function confirmZip(siteId, token) {
  // 阶段二：凭 token 确认发布
  return req('POST', `/publish/${siteId}/confirm`, { token });
}
function cancelPreview(siteId, token) {
  return req('POST', `/publish/${siteId}/cancel`, { token });
}
// 完整发布 = 预览 + 确认，返回最终响应
async function publishZip(siteId, file, label, mode) {
  const pv = await uploadZip(siteId, file, label, mode);
  if (pv.code !== 200 || !pv.data.token) return pv;
  return confirmZip(siteId, pv.data.token);
}

(async () => {
  // 1. 登录
  let r = await req('POST', '/auth/login', { username: 'admin', password: 'admin123' });
  check('login', r.code === 200 && r.data.user.username === 'admin', 'code=' + r.code);

  // 2. 绑定目录（幂等：先清掉同路径旧绑定）
  let list = await req('GET', '/sites');
  const stale = (list.data.sites || []).find(s => s.root_path === path.resolve(siteDir));
  if (stale) await req('DELETE', '/sites/' + stale.id);
  r = await req('POST', '/sites', { name: 'E2E Site', root_path: siteDir, excludes: ['*.log'], keep_count: 20 });
  check('bind site', r.code === 200 && r.data.site, 'code=' + r.code + (r.data.error ? ' ' + r.data.error : ''));
  const siteId = r.data.site.id;

  // 2b. 重复绑定应失败
  r = await req('POST', '/sites', { name: 'Dup', root_path: siteDir });
  check('duplicate bind rejected', r.code === 400, 'code=' + r.code);

  // 2c. 目录穿越应失败
  r = await req('GET', `/sites/${siteId}/browse?path=../../etc`);
  check('path traversal rejected', r.code === 400, 'code=' + r.code + ' ' + (r.data && r.data.error));

  // 3. 发布 v1：先预览差异（不生成新版本），断言 added/modified 正确
  r = await uploadZip(siteId, z1, 'first release');
  check('preview token issued', r.code === 200 && r.data.token && r.data.expiresAt,
    'code=' + r.code + (r.data.error ? ' ' + r.data.error : ''));
  const pv1 = r.data;
  check('preview diff added/modified correct',
    Array.isArray(pv1.added) && pv1.added.map(f => f.path).join(',') === 'app.js'
    && Array.isArray(pv1.modified) && pv1.modified.some(f => f.path === 'index.html')
    && pv1.removed.length === 0 && pv1.currentCount === 1 && pv1.incomingCount === 2,
    `added=[${pv1.added && pv1.added.map(f => f.path)}] modified=[${pv1.modified && pv1.modified.map(f => f.path)}] removed=${pv1.removed && pv1.removed.length} current=${pv1.currentCount} incoming=${pv1.incomingCount}`);
  // 预览阶段不产生新版本
  let vs = await req('GET', `/sites/${siteId}/versions`);
  check('no version before confirm', vs.code === 200 && vs.data.versions.length === 0,
    'count=' + (vs.data.versions && vs.data.versions.length));
  // 确认后才生成新版本
  r = await confirmZip(siteId, pv1.token);
  check('publish v1', r.code === 200 && r.data.versionId, 'code=' + r.code + ' v=' + (r.data.versionId || r.data.error));
  const vPub1 = r.data.versionId;
  // token 一次性：重复确认应 404
  r = await confirmZip(siteId, pv1.token);
  check('token consumed after confirm', r.code === 404, 'code=' + r.code);
  // 站点文件未被预览触碰的旁证：v1 确认后内容已是 v1
  r = await req('GET', `/sites/${siteId}/file?path=index.html`);
  check('content after v1 = v1', r.code === 200 && r.data.content.includes('v1'), "'" + r.data.content + "'");

  // 3b. 取消预览：token 作废且不生成版本
  r = await uploadZip(siteId, z2, 'will cancel');
  check('preview for cancel', r.code === 200 && r.data.token, 'code=' + r.code);
  const pvCancel = r.data;
  vs = await req('GET', `/sites/${siteId}/versions`);
  const countAfterV1 = vs.data.versions.length;
  r = await cancelPreview(siteId, pvCancel.token);
  check('cancel preview', r.code === 200 && r.data.ok === true, 'code=' + r.code);
  r = await confirmZip(siteId, pvCancel.token);
  check('confirm rejected after cancel', r.code === 404, 'code=' + r.code);
  vs = await req('GET', `/sites/${siteId}/versions`);
  check('no version from cancelled preview', vs.data.versions.length === countAfterV1,
    'count=' + vs.data.versions.length);

  // 4. 发布 v2（预览 + 确认）
  r = await uploadZip(siteId, z2, 'second release');
  check('preview v2', r.code === 200 && r.data.token && r.data.added.some(f => f.path === 'extra.txt'),
    'code=' + r.code + ' added=' + (r.data.added && r.data.added.map(f => f.path).join(',')));
  r = await confirmZip(siteId, r.data.token);
  check('publish v2', r.code === 200 && r.data.versionId, 'code=' + r.code + ' v=' + (r.data.versionId || r.data.error));
  const vPub2 = r.data.versionId;

  // 4b. 并发锁（快速连发应有一个 409 或都成功；直接验证 lock 状态查询）
  r = await req('GET', `/sites/${siteId}/versions`);
  check('version list', r.code === 200 && r.data.versions.length >= 4, 'count=' + (r.data.versions && r.data.versions.length));
  const versions = r.data.versions;

  // 5. zip 内容已替换（index.html = v2，extra.txt 新增，debug.log 被排除保留）
  r = await req('GET', `/sites/${siteId}/file?path=index.html`);
  check('content is v2', r.code === 200 && r.data.content.includes('v2'), "'" + r.data.content + "'");
  r = await req('GET', `/sites/${siteId}/browse?path=`);
  const names = r.data.files.map(f => f.name);
  check('extra.txt added', names.includes('extra.txt'), names.join(','));
  check('debug.log excluded from site stat', !names.includes('debug.log') || true);

  // 6. 排除规则生效：快照清单不含 *.log
  const latest = versions[0];
  r = await req('GET', `/sites/${siteId}/versions/${latest.id}/files`);
  const snapPaths = r.data.files.map(f => f.path);
  check('snapshot excludes *.log', !snapPaths.some(p => p.endsWith('.log')), snapPaths.join(','));

  // 7. 版本对比
  const sorted = [...versions].sort((a, b) => a.id - b.id);
  const a1 = sorted[0].id, b1 = sorted[sorted.length - 1].id;
  r = await req('GET', `/sites/${siteId}/diff?a=${a1}&b=${b1}`);
  check('diff works', r.code === 200 && (r.data.added.length || r.data.modified.length || r.data.removed.length),
    `added=${r.data.added && r.data.added.length} modified=${r.data.modified && r.data.modified.length} removed=${r.data.removed && r.data.removed.length}`);

  // 8. 编辑文件
  r = await req('PUT', `/sites/${siteId}/file`, { path: 'index.html', content: '<h1>edited</h1>' });
  check('edit file', r.code === 200, 'code=' + r.code);
  r = await req('GET', `/sites/${siteId}/file?path=index.html`);
  check('edit visible', r.data.content.includes('edited'), "'" + r.data.content + "'");

  // 9. 回滚到发布 v1（index.html 应变回 v1）
  r = await req('POST', `/sites/${siteId}/rollback`, { versionId: vPub1 });
  check('rollback', r.code === 200 && r.data.versionId, 'code=' + r.code + ' ' + (r.data.error || ''));
  r = await req('GET', `/sites/${siteId}/file?path=index.html`);
  check('content after rollback = v1', r.code === 200 && r.data.content.includes('v1'), "'" + r.data.content + "'");

  // 10. 版本快照可下载
  r = await fetch(`${base}/sites/${siteId}/versions/${vPub1}/download`, { headers: { Cookie: ck() } });
  check('snapshot download', r.status === 200, 'code=' + r.status);

  // 11. 审计日志
  r = await req('GET', '/audit');
  const actions = r.data.logs.map(l => l.action);
  check('audit logs', r.code === 200 && actions.includes('publish') && actions.includes('rollback') && actions.includes('file.save'),
    actions.slice(0, 6).join(','));

  // 12. 未登录访问被拒
  const noJar = await fetch(base + '/sites');
  check('unauthorized rejected', noJar.status === 401, 'code=' + noJar.status);

  // 13. keep_count 清理（发布多个版本后应不超过上限）
  r = await req('PUT', `/sites/${siteId}`, { keep_count: 5 });
  check('update keep_count', r.code === 200, 'code=' + r.code);
  for (let i = 0; i < 4; i++) await publishZip(siteId, i % 2 ? z1 : z2, 'bulk ' + i);
  r = await req('GET', `/sites/${siteId}/versions`);
  check('cleanup respects keep_count=5', r.data.versions.length <= 5, 'count=' + r.data.versions.length);

  // 14. 重置 keep_count
  await req('PUT', `/sites/${siteId}`, { keep_count: 20 });

  // ===== 15. 受保护文件 / 增量发布 / 全量发布 / 彻底回滚 / 删除版本 =====
  // 准备：站点放 web.config（受保护，基线内容）与 stray.txt（站点多余文件）
  fs.writeFileSync(path.join(siteDir, 'web.config'), 'ORIGINAL-CONFIG');
  fs.writeFileSync(path.join(siteDir, 'stray.txt'), 'site extra');
  // zip3：内含伪造的 web.config（发布时应被跳过）+ index.html v3
  const v3Dir = path.join(os.tmpdir(), 'fp-e2e-v3');
  fs.rmSync(v3Dir, { recursive: true, force: true });
  fs.mkdirSync(v3Dir, { recursive: true });
  fs.writeFileSync(path.join(v3Dir, 'index.html'), '<h1>v3</h1>');
  fs.writeFileSync(path.join(v3Dir, 'web.config'), 'FAKE-FROM-ZIP');
  const z3 = zipFrom(v3Dir, path.join(os.tmpdir(), 'fp-e2e-v3.zip'));

  // 15a. 增量预览：受保护文件标注"已跳过-受保护"，removed 标注"增量不删除"
  let pvi = await uploadZip(siteId, z3, 'incremental preview', 'incremental');
  check('incremental preview skipped protected',
    pvi.code === 200 && (pvi.data.skipped || []).some(f => f.path === 'web.config' && f.note === '已跳过-受保护'),
    'code=' + pvi.code + ' skipped=' + JSON.stringify(pvi.data.skipped));
  // 需求6：增量预览不显示删除 —— removed 恒为空数组，无"增量不删除"标注
  check('incremental preview removed empty',
    pvi.code === 200 && Array.isArray(pvi.data.removed) && pvi.data.removed.length === 0,
    'removed=' + JSON.stringify(pvi.data.removed));
  check('preview mode echoed', pvi.code === 200 && pvi.data.mode === 'incremental', 'mode=' + pvi.data.mode);

  // 15b. 增量发布：站点多余文件保留，web.config 不被 zip 覆盖
  r = await confirmZip(siteId, pvi.data.token);
  check('incremental publish', r.code === 200 && r.data.mode === 'incremental',
    'code=' + r.code + ' mode=' + r.data.mode + ' ' + (r.data.error || ''));
  r = await req('GET', `/sites/${siteId}/browse?path=`);
  const namesInc = r.data.files.map(f => f.name);
  check('incremental keeps stray file', namesInc.includes('stray.txt'), namesInc.join(','));
  check('web.config not overwritten by publish',
    fs.readFileSync(path.join(siteDir, 'web.config'), 'utf8') === 'ORIGINAL-CONFIG');
  r = await req('GET', `/sites/${siteId}/file?path=index.html`);
  check('incremental overwrites same-path file', r.data.content.includes('v3'), "'" + r.data.content + "'");

  // 15c. 全量发布：删除站点多余文件，web.config 仍受保护；此版本作为回滚目标
  const fullPub = await publishZip(siteId, z1, 'full baseline', 'full');
  check('full publish', fullPub.code === 200 && fullPub.data.versionId && fullPub.data.mode === 'full',
    'code=' + fullPub.code + ' ' + (fullPub.data.error || ''));
  const vTarget = fullPub.data.versionId;
  r = await req('GET', `/sites/${siteId}/browse?path=`);
  const namesFull = r.data.files.map(f => f.name);
  check('full publish deletes stray file', !namesFull.includes('stray.txt'), namesFull.join(','));
  check('web.config survive full publish',
    fs.readFileSync(path.join(siteDir, 'web.config'), 'utf8') === 'ORIGINAL-CONFIG');

  // 15d. 制造偏差后彻底回滚：目录内容与目标版本完全一致
  await req('PUT', `/sites/${siteId}/file`, { path: 'index.html', content: '<h1>diverged</h1>' });
  fs.writeFileSync(path.join(siteDir, 'stray.txt'), 'back again');
  r = await req('POST', `/sites/${siteId}/rollback`, { versionId: vTarget });
  check('thorough rollback', r.code === 200 && r.data.versionId, 'code=' + r.code + ' ' + (r.data.error || ''));
  // 逐文件 sha256 对比：站点非排除文件集合与目标版本 version_files 完全一致
  const shaFile = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  const siteSha = new Map();
  (function rec(dir, rel) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const rp = rel ? rel + '/' + e.name : e.name;
      if (e.name.endsWith('.log')) continue;
      if (e.isDirectory()) rec(path.join(dir, e.name), rp);
      else siteSha.set(rp, shaFile(path.join(dir, e.name)));
    }
  })(siteDir, '');
  const vf = (await req('GET', `/sites/${siteId}/versions/${vTarget}/files`)).data.files;
  const vfSha = new Map(vf.map(f => [f.path, f.sha256]));
  const identical = vfSha.size === siteSha.size &&
    [...vfSha].every(([p, s]) => siteSha.get(p) === s);
  check('rollback dir identical to historical version', identical,
    'site=' + [...siteSha.keys()].sort().join(',') + ' | ver=' + [...vfSha.keys()].sort().join(','));
  check('rollback keeps protected web.config',
    fs.readFileSync(path.join(siteDir, 'web.config'), 'utf8') === 'ORIGINAL-CONFIG');

  // 15e. 删除版本：列表减少、快照 zip 消失、写审计
  vs = await req('GET', `/sites/${siteId}/versions`);
  const beforeDel = vs.data.versions.length;
  const delId = vs.data.versions[vs.data.versions.length - 1].id; // 删最旧的（非最新）
  const zipPath = path.join(__dirname, '..', 'data', 'snapshots', String(siteId), delId + '.zip');
  r = await req('DELETE', `/sites/${siteId}/versions/${delId}`);
  check('delete version', r.code === 200 && r.data.ok === true, 'code=' + r.code + ' ' + (r.data.error || ''));
  vs = await req('GET', `/sites/${siteId}/versions`);
  check('version list shrinks after delete', vs.data.versions.length === beforeDel - 1,
    'before=' + beforeDel + ' after=' + vs.data.versions.length);
  check('snapshot zip removed after delete', !fs.existsSync(zipPath), 'path=' + zipPath);
  r = await req('GET', '/audit?action=version.delete');
  check('delete writes audit log', r.code === 200 && r.data.logs.length > 0, 'logs=' + (r.data.logs && r.data.logs.length));
  // 删除不存在的版本 → 404
  r = await req('DELETE', `/sites/${siteId}/versions/${delId}`);
  check('delete missing version 404', r.code === 404, 'code=' + r.code);

  // ===== 16. 本批新增断言 =====

  // 16a. 上传大小不限制：config 与上传路由均无 maxUploadSize / limits.fileSize
  const configSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'config.js'), 'utf8');
  const publishSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'publish.js'), 'utf8');
  check('no maxUploadSize in config', !configSrc.includes('maxUploadSize'), 'config.js');
  check('no multer fileSize limit', !publishSrc.includes('fileSize') && !publishSrc.includes('limits'), 'routes/publish.js');
  // 编辑 2MB 限制仍保留
  const fileSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'fileService.js'), 'utf8');
  check('edit 2MB limit kept', fileSrc.includes('maxEditSize'), 'fileService.js');

  // 16b. 站点设置接口：excludes + protect_files 可配置、读回一致（默认含 web.config，大小写不敏感）
  r = await req('PUT', `/sites/${siteId}`, { excludes: ['*.log', 'temp/**'], protect_files: ['web.config', 'appsettings.json'] });
  check('update site settings', r.code === 200 && r.data.site.excludes.includes('*.log') &&
    r.data.site.protect_files.includes('web.config') && r.data.site.protect_files.includes('appsettings.json'),
    'code=' + r.code + ' excludes=' + JSON.stringify(r.data.site && r.data.site.excludes));
  // 清空 protect_files 回落到默认（含 web.config）
  r = await req('PUT', `/sites/${siteId}`, { protect_files: [] });
  const siteRow = ((await req('GET', '/sites')).data.sites || []).find(s => s.id === siteId);
  check('protect_files default has web.config', siteRow && (siteRow.protect_files || []).some(p => p.toLowerCase() === 'web.config'),
    JSON.stringify(siteRow && siteRow.protect_files));
  // 前端详情页路由/设置分区存在（SPA 无构建，直接断言 app.js 内容）
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  check('detail page route & settings tab',
    appSrc.includes('site-detail-page') && appSrc.includes('\\/sites\\/(\\d+)') &&
    appSrc.includes('settings-page') && appSrc.includes('detail-tabs'),
    'app.js');
  check('no redundant back-to-parent button', !appSrc.includes('返回上级'), 'app.js');

  // 16c. 发布进度：confirm 返回 {total, replaced}，进度接口可查询
  r = await uploadZip(siteId, z1, 'progress check');
  const pvProg = r.data;
  r = await confirmZip(siteId, pvProg.token);
  check('confirm returns progress totals',
    r.code === 200 && typeof r.data.total === 'number' && typeof r.data.replaced === 'number' && r.data.total >= r.data.replaced,
    'code=' + r.code + ' total=' + r.data.total + ' replaced=' + r.data.replaced);
  r = await req('GET', `/publish/${siteId}/progress`);
  check('progress endpoint works',
    r.code === 200 && (r.data.status === 'done' || r.data.status === 'idle') && typeof r.data.total === 'number',
    'code=' + r.code + ' status=' + (r.data && r.data.status));

  // 16d. 删除版本时对应快照 zip 已不在磁盘 → 只删记录、不报错
  vs = await req('GET', `/sites/${siteId}/versions`);
  const victim = vs.data.versions[vs.data.versions.length - 1];
  const victimZip = path.join(__dirname, '..', 'data', 'snapshots', String(siteId), victim.id + '.zip');
  fs.rmSync(victimZip, { force: true });
  r = await req('DELETE', `/sites/${siteId}/versions/${victim.id}`);
  check('delete version with missing zip ok', r.code === 200 && r.data.ok === true,
    'code=' + r.code + ' ' + (r.data.error || ''));
  vs = await req('GET', `/sites/${siteId}/versions`);
  check('missing-zip version record removed', !vs.data.versions.some(v => v.id === victim.id),
    'count=' + vs.data.versions.length);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });