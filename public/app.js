const { createApp, ref, reactive, computed, onMounted, watch, onUnmounted } = Vue;

async function api(url, opts = {}) {
  const init = { headers: {}, ...opts };
  if (init.body && !(init.body instanceof FormData)) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(init.body);
  }
  const res = await fetch('/api' + url, init);
  if (res.status === 401) { location.hash = '#/login'; throw new Error('未登录'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '请求失败');
  return data;
}

const fmtSize = n => {
  if (n == null) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v.toFixed(i ? 1 : 0) + ' ' + u[i];
};
const fmtTime = t => (t || '').replace('T', ' ').slice(0, 19);

// ===== 应用内确认弹窗：仅按钮可关闭，禁止点击遮罩关闭 =====
const ConfirmModal = {
  props: {
    show: Boolean,
    title: { type: String, default: '确认操作' },
    message: { type: String, default: '' },
    confirmText: { type: String, default: '确认' },
    cancelText: { type: String, default: '取消' },
    danger: Boolean,
    busy: Boolean
  },
  emits: ['confirm', 'cancel'],
  template: `
  <div class="modal-mask" v-if="show">
    <div class="modal">
      <div class="modal-title">{{ title }}</div>
      <p class="confirm-text">{{ message }}</p>
      <div class="form-actions">
        <button class="btn-secondary" @click="$emit('cancel')" :disabled="busy">{{ cancelText }}</button>
        <button :class="danger ? 'btn-danger' : 'btn-primary'" @click="$emit('confirm')" :disabled="busy">{{ busy ? '处理中...' : confirmText }}</button>
      </div>
    </div>
  </div>`
};

// ===== 差异三列展示（发布预览 / 版本对比复用）；hideRemoved=true 时整个删除类目不展示（增量模式） =====
const DiffColumns = {
  props: { diff: { type: Object, required: true }, hideRemoved: Boolean },
  template: `
  <div class="diff-cols" :class="{ two: hideRemoved }">
    <div class="diff-col added">
      <h4>新增 · {{ diff.added.length }}</h4>
      <ul><li v-for="f in diff.added" :key="'a'+f.path"><span>{{ f.path }}</span><span class="delta">{{ f.size != null ? $root.fmtSize(f.size) : '' }}</span></li></ul>
      <div class="empty" v-if="!diff.added.length">无新增文件</div>
    </div>
    <div class="diff-col modified">
      <h4>修改 · {{ diff.modified.length }}</h4>
      <ul><li v-for="f in diff.modified" :key="'m'+f.path"><span>{{ f.path }}</span><span class="delta" v-if="f.from != null">{{ $root.fmtSize(f.from) }} → {{ $root.fmtSize(f.to) }}</span></li></ul>
      <div class="empty" v-if="!diff.modified.length">无修改文件</div>
    </div>
    <div class="diff-col removed" v-if="!hideRemoved">
      <h4>删除 · {{ diff.removed.length }}</h4>
      <ul><li v-for="f in diff.removed" :key="'d'+f.path"><span>{{ f.path }}</span><span class="delta" v-if="f.note">{{ f.note }}</span><span class="delta" v-else-if="f.size != null">{{ $root.fmtSize(f.size) }}</span></li></ul>
      <div class="empty" v-if="!diff.removed.length">无删除文件</div>
    </div>
  </div>`
};

const SitesPage = {
  props: ['notify', 'fmtSize', 'fmtTime', 'navigate'],
  setup(props) {
    const sites = ref([]);
    const showModal = ref(false);
    const form = reactive({ name: '', root_path: '', excludes: '*.log\nnode_modules\n.git', protect_files: 'web.config\nWeb.config', keep_count: 10 });
    const load = async () => {
      try { sites.value = (await api('/sites')).sites; }
      catch (e) { props.notify(e.message, 'err'); }
    };
    onMounted(load);
    const openAdd = () => {
      Object.assign(form, { name: '', root_path: '', excludes: '*.log\nnode_modules\n.git', protect_files: 'web.config\nWeb.config', keep_count: 10 });
      showModal.value = true;
    };
    const save = async () => {
      const body = {
        name: form.name, root_path: form.root_path,
        excludes: form.excludes.split('\n').map(s => s.trim()).filter(Boolean),
        protect_files: form.protect_files.split('\n').map(s => s.trim()).filter(Boolean),
        keep_count: Number(form.keep_count)
      };
      try {
        await api('/sites', { method: 'POST', body });
        showModal.value = false;
        props.notify('保存成功');
        load();
      } catch (e) { props.notify(e.message, 'err'); }
    };
    return { sites, showModal, form, openAdd, save };
  },
  template: `
  <div>
    <div class="page-head">
      <div><div class="eyebrow">SITES</div><div class="page-title">站点</div></div>
      <button class="btn-primary" @click="openAdd">+ 绑定目录</button>
    </div>
    <div class="grid">
      <div class="site-card clickable" v-for="s in sites" :key="s.id" @click="navigate('#/sites/'+s.id)" title="进入站点详情">
        <h3>{{ s.name }} <span v-if="s.locked" class="badge lock">发布中</span></h3>
        <div class="path">{{ s.root_path }}</div>
        <div class="stats">
          <span>{{ s.fileCount }} 个文件</span>
          <span>{{ fmtSize(s.totalSize) }}</span>
          <span class="stat-new" v-if="s.latest">最新 v{{ s.latest.id }}</span>
        </div>
        <div class="card-hint muted">点击进入站点详情 →</div>
      </div>
    </div>
    <div v-if="!sites.length" class="card muted">还没有绑定目录，点击右上角绑定 IIS 站点的工作目录。</div>

    <div v-if="showModal" class="modal-mask">
      <div class="modal">
        <div class="modal-title">绑定工作目录</div>
        <div class="form-row"><label>站点名称</label><input v-model="form.name" placeholder="如：Default Web Site" /></div>
        <div class="form-row"><label>目录绝对路径</label><input v-model="form.root_path" placeholder="D:\\inetpub\\wwwroot\\myapp" /></div>
        <div class="form-row"><label>排除规则（每行一个 glob，不参与快照/统计）</label><textarea rows="3" v-model="form.excludes"></textarea></div>
        <div class="form-row"><label>受保护文件（每行一个文件名，参与快照但发布/回滚不覆盖）</label><textarea rows="2" v-model="form.protect_files" placeholder="web.config"></textarea></div>
        <div class="form-row"><label>保留版本数</label><input type="number" v-model.number="form.keep_count" min="1" /></div>
        <div class="form-actions">
          <button class="btn-secondary" @click="showModal=false">取消</button>
          <button class="btn-primary" @click="save">保存</button>
        </div>
      </div>
    </div>
  </div>`
};

const FilesPage = {
  props: ['siteId', 'notify', 'fmtSize', 'navigate'],
  setup(props) {
    const current = ref('');
    const data = ref({ dirs: [], files: [] });
    const editingFile = ref(null);
    const editor = reactive({ path: '', content: '', dirty: false, saving: false });
    const load = async (p = current.value) => {
      try {
        data.value = await api(`/sites/${props.siteId}/browse?path=${encodeURIComponent(p)}`);
        current.value = data.value.path;
        editingFile.value = null;
      } catch (e) { props.notify(e.message, 'err'); }
    };
    onMounted(() => load(''));
    const go = p => load(p);
    const up = () => {
      const parts = current.value.split('/').filter(Boolean);
      parts.pop();
      load(parts.join('/'));
    };
    const openFile = async f => {
      if (/\.(png|jpg|jpeg|gif|zip|pdf|exe|dll|woff2?|ico|mp4)$/i.test(f.name)) {
        window.open(`/api/sites/${props.siteId}/file/download?path=${encodeURIComponent(f.path)}`, '_blank');
        return;
      }
      try {
        const r = await api(`/sites/${props.siteId}/file?path=${encodeURIComponent(f.path)}`);
        editingFile.value = f.path;
        editor.path = r.path; editor.content = r.content; editor.dirty = false;
      } catch (e) { props.notify(e.message, 'err'); }
    };
    const save = async () => {
      editor.saving = true;
      try {
        await api(`/sites/${props.siteId}/file`, { method: 'PUT', body: { path: editor.path, content: editor.content } });
        editor.dirty = false;
        props.notify('已保存');
      } catch (e) { props.notify(e.message, 'err'); }
      finally { editor.saving = false; }
    };
    return { current, data, editingFile, editor, load, go, up, openFile, save };
  },
  template: `
  <div>
    <div class="page-head"><div><div class="eyebrow">FILES</div><div class="page-title">文件浏览 / 编辑</div></div></div>
    <div class="card">
      <div class="browse-bar">
        <button class="btn-secondary" @click="up" :disabled="!current">上级</button>
        <div class="breadcrumb"><a @click="go('')">根目录</a><template v-for="p in current.split('/').filter(Boolean)" :key="p"> / <a @click="go(current.split('/').slice(0, current.split('/').filter(Boolean).indexOf(p)+1).join('/'))">{{ p }}</a></template></div>
        <span class="muted">{{ data.files.length }} 文件 / {{ data.dirs.length }} 目录</span>
      </div>
      <table>
        <thead><tr><th>名称</th><th style="width:110px">大小</th><th style="width:170px">修改时间</th></tr></thead>
        <tbody>
          <tr v-for="d in data.dirs" :key="'d'+d.path" @click="go(d.path)" style="cursor:pointer">
            <td>📁 {{ d.name }}</td><td class="mono">-</td><td class="mono">-</td>
          </tr>
          <tr v-for="f in data.files" :key="'f'+f.path" @click="openFile(f)" style="cursor:pointer">
            <td>📄 {{ f.name }}</td><td class="mono">{{ fmtSize(f.size) }}</td><td class="mono">{{ f.mtime.replace('T',' ').slice(0,19) }}</td>
          </tr>
        </tbody>
      </table>
      <div v-if="!data.dirs.length && !data.files.length" class="muted" style="padding:10px">空目录</div>
    </div>
    <div class="card" v-if="editingFile">
      <div class="browse-bar">
        <strong class="mono" style="word-break:break-all">{{ editingFile }}</strong>
        <span v-if="editor.dirty" class="badge lock">未保存</span>
        <button class="btn-primary" @click="save" :disabled="editor.saving || !editor.dirty">{{ editor.saving ? '保存中...' : '保存' }}</button>
        <button class="btn-ghost" @click="editingFile=null">关闭</button>
      </div>
      <textarea class="editor" v-model="editor.content" @input="editor.dirty=true" spellcheck="false"></textarea>
    </div>
  </div>`
};

// ===== 发布页：两阶段（上传预览差异 → 确认发布） =====
const PublishPage = {
  props: ['siteId', 'notify', 'navigate'],
  setup(props) {
    const file = ref(null);
    const label = ref('');
    const mode = ref('full');    // 发布模式：full=全量（删除后替换），incremental=增量（只新增/覆盖）
    const busy = ref(false);      // 上传预览中
    const publishing = ref(false); // 确认发布中
    const locked = ref(false);
    const preview = ref(null);     // { token, added, modified, removed, skipped, mode, currentCount, incomingCount, expiresAt }
    const onFile = e => (file.value = e.target.files[0] || null);
    const reset = () => { file.value = null; preview.value = null; const i = document.getElementById('pv-file'); if (i) i.value = ''; };

    // 阶段一：上传 zip，拿差异清单与 preview token（不替换文件）
    const doPreview = async () => {
      if (!file.value) return props.notify('请选择 zip 文件', 'err');
      busy.value = true; locked.value = false;
      const fd = new FormData();
      fd.append('file', file.value);
      fd.append('label', label.value);
      fd.append('mode', mode.value);
      try {
        preview.value = await api(`/publish/${props.siteId}`, { method: 'POST', body: fd });
        props.notify('差异已生成，请核对后确认发布');
      } catch (e) {
        if (/发布\/回滚中/.test(e.message)) locked.value = true;
        props.notify(e.message, 'err');
      } finally { busy.value = false; }
    };

    // 阶段二：凭 token 确认发布；确认后并行轮询进度接口渲染进度条
    const progress = ref(null); // { status, phase, total, replaced }
    let pollTimer = null;
    const pollProgress = () => {
      if (pollTimer) return;
      pollTimer = setInterval(async () => {
        try {
          const st = await api(`/publish/${props.siteId}/progress`);
          progress.value = st;
          if (st.status !== 'running') { clearInterval(pollTimer); pollTimer = null; }
        } catch { /* 忽略瞬时错误，继续轮询 */ }
      }, 200);
    };
    onUnmounted(() => { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } });
    const confirmPublish = async () => {
      if (!preview.value) return;
      publishing.value = true; locked.value = false;
      progress.value = { status: 'running', phase: 'preparing', total: 0, replaced: 0 };
      pollProgress();
      try {
        const r = await api(`/publish/${props.siteId}/confirm`, { method: 'POST', body: { token: preview.value.token } });
        if (r.total != null) progress.value = { status: 'done', phase: 'done', total: r.total, replaced: r.replaced };
        props.notify('发布成功，版本 v' + r.versionId);
        reset();
        props.navigate('#/sites/' + props.siteId + '/versions');
      } catch (e) {
        if (/发布\/回滚中/.test(e.message)) locked.value = true;
        if (/过期|不存在/.test(e.message)) preview.value = null;
        progress.value = null;
        props.notify(e.message, 'err');
      } finally {
        publishing.value = false;
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      }
    };

    // 取消预览：服务端删除 token 与临时 zip
    const cancelPreview = async () => {
      if (!preview.value) { reset(); return; }
      try { await api(`/publish/${props.siteId}/cancel`, { method: 'POST', body: { token: preview.value.token } }); } catch {}
      reset();
      props.notify('已取消预览');
    };

    return { file, label, mode, busy, publishing, locked, preview, progress, onFile, reset, doPreview, confirmPublish, cancelPreview };
  },
  template: `
  <div>
    <div class="page-head"><div><div class="eyebrow">PUBLISH</div><div class="page-title">发布新版本</div></div></div>

    <div class="card" v-if="!preview">
      <div class="form-row"><label>版本说明（可选）</label><input v-model="label" placeholder="如：修复登录问题 v1.2" /></div>
      <div class="form-row"><label>压缩包 (.zip)</label><input id="pv-file" type="file" accept=".zip" @change="onFile" /></div>
      <div class="form-row"><label>发布模式</label>
        <select v-model="mode">
          <option value="full">全量发布 — 删除站点多余文件后整体替换</option>
          <option value="incremental">增量发布 — 只新增/覆盖同路径文件，不删除站点多余文件</option>
        </select>
      </div>
      <p class="prose" style="margin-bottom:16px">
        发布分两步：先上传生成差异预览（不改动站点文件），核对新增 / 修改 / 删除清单后再确认发布。
        确认时当前文件自动打包为旧版快照 → 按所选模式更新站点目录 → 生成新版本记录，期间站点锁定。
        受保护文件（如 web.config）与排除文件始终不受影响。
      </p>
      <div v-if="locked" class="badge lock" style="margin-bottom:10px">该站点正在发布/回滚中，请稍后再试</div>
      <button class="btn-primary" @click="doPreview" :disabled="busy">{{ busy ? '解析中...' : '上传并预览差异' }}</button>
    </div>

    <div class="card" v-else>
      <div class="preview-panel">
        <div class="preview-head">
          <div>
            <div class="eyebrow" style="margin-bottom:2px">DIFF PREVIEW</div>
            <div class="section-title">差异预览 · {{ label || '未填写版本说明' }}</div>
          </div>
          <div class="token-line">当前 {{ preview.currentCount }} 个文件 → 发布后 {{ preview.incomingCount }} 个文件 · 有效期至 {{ preview.expiresAt.replace('T',' ').slice(0,19) }}</div>
        </div>
        <div class="diff-summary">
          <span>新增 <b>{{ preview.added.length }}</b></span>
          <span>修改 <b>{{ preview.modified.length }}</b></span>
          <span v-if="preview.mode!=='incremental'">删除 <b>{{ preview.removed.length }}</b></span>
          <span v-if="preview.skipped && preview.skipped.length">已跳过-受保护 <b>{{ preview.skipped.length }}</b></span>
          <span>模式 <b>{{ preview.mode==='incremental' ? '增量' : '全量' }}</b></span>
        </div>
        <diff-columns :diff="preview" :hide-removed="preview.mode==='incremental'" />
        <div v-if="preview.skipped && preview.skipped.length" class="token-line" style="margin-top:8px">
          已跳过-受保护：{{ preview.skipped.map(f => f.path).join('、') }}
        </div>
      </div>
      <p class="prose" style="margin:16px 0">确认后才会按所选模式更新站点文件并生成新版本；取消则本次上传作废。</p>
      <div v-if="locked" class="badge lock" style="margin-bottom:10px">该站点正在发布/回滚中，请稍后再试</div>
      <div v-if="publishing && progress" class="progress-wrap">
        <div class="progress-text">正在替换文件：共 {{ progress.total || '…' }} 个，已替换 {{ progress.replaced }} 个<span v-if="progress.phase==='archiving'">（正在打包快照）</span><span v-else-if="progress.phase==='preparing'">（准备中）</span></div>
        <div class="progress-bar"><div class="progress-fill" :style="{ width: (progress.total ? Math.min(100, Math.round(progress.replaced / progress.total * 100)) : 0) + '%' }"></div></div>
      </div>
      <button class="btn-primary" @click="confirmPublish" :disabled="publishing">{{ publishing ? '发布中，请勿关闭页面...' : '确认发布' }}</button>
      <button class="btn-secondary" style="margin-left:10px" @click="cancelPreview" :disabled="publishing">取消</button>
    </div>
  </div>`
};

const VersionsPage = {
  props: ['siteId', 'notify', 'fmtSize', 'fmtTime', 'navigate'],
  setup(props) {
    const versions = ref([]);
    const locked = ref(null);
    const viewFiles = ref(null);
    const viewFilesList = ref([]);
    const diffOpen = ref(false);
    const selA = ref(null), selB = ref(null);
    const diff = ref(null);
    const confirmState = reactive({ show: false, version: null, busy: false });
    const load = async () => {
      try {
        const r = await api(`/sites/${props.siteId}/versions`);
        versions.value = r.versions;
        locked.value = r.locked;
      } catch (e) { props.notify(e.message, 'err'); }
    };
    onMounted(load);
    const showFiles = async v => {
      try {
        const r = await api(`/sites/${props.siteId}/versions/${v.id}/files`);
        viewFilesList.value = Array.isArray(r.files) ? r.files : [];
        viewFiles.value = v;
      } catch (e) { props.notify('文件清单加载失败：' + e.message, 'err'); }
    };
    const doDiff = async () => {
      if (!selA.value || !selB.value) return props.notify('请选择两个版本', 'err');
      try {
        diff.value = await api(`/sites/${props.siteId}/diff?a=${selA.value}&b=${selB.value}`);
        diffOpen.value = true;
      } catch (e) { props.notify(e.message, 'err'); }
    };
    // 回滚确认：应用内弹窗（仅按钮关闭）
    const askRollback = v => { confirmState.version = v; confirmState.show = true; };
    const doRollback = async () => {
      confirmState.busy = true;
      try {
        const r = await api(`/sites/${props.siteId}/rollback`, { method: 'POST', body: { versionId: confirmState.version.id } });
        confirmState.show = false;
        props.notify('回滚完成，当前版本 v' + r.versionId);
        load();
      } catch (e) { props.notify(e.message, 'err'); }
      finally { confirmState.busy = false; }
    };
    const download = v => window.open(`/api/sites/${props.siteId}/versions/${v.id}/download`, '_blank');
    // 删除版本：应用内确认弹窗（仅按钮关闭）；最新版本仅提示不推荐但允许
    const delState = reactive({ show: false, version: null, busy: false });
    const askDelete = v => {
      const latest = versions.value[0];
      delState.version = v;
      delState.warn = latest && latest.id === v.id;
      delState.show = true;
    };
    const doDelete = async () => {
      delState.busy = true;
      try {
        await api(`/sites/${props.siteId}/versions/${delState.version.id}`, { method: 'DELETE' });
        delState.show = false;
        props.notify('已删除版本 v' + delState.version.id);
        load();
      } catch (e) { props.notify(e.message, 'err'); }
      finally { delState.busy = false; }
    };
    return { versions, locked, viewFiles, viewFilesList, diffOpen, selA, selB, diff, confirmState, delState, load, showFiles, doDiff, askRollback, doRollback, download, askDelete, doDelete };
  },
  template: `
  <div>
    <div class="page-head">
      <div><div class="eyebrow">VERSIONS</div><div class="page-title">版本历史 <span v-if="locked" class="badge lock">发布/回滚进行中...</span></div></div>
    </div>
    <div class="card">
      <div class="browse-bar">
        <select v-model="selA"><option :value="null">选择版本 A</option><option v-for="v in versions" :key="v.id" :value="v.id">v{{ v.id }} · {{ v.label || v.kind }} · {{ fmtTime(v.created_at) }}</option></select>
        <span class="muted">对比</span>
        <select v-model="selB"><option :value="null">选择版本 B</option><option v-for="v in versions" :key="v.id" :value="v.id">v{{ v.id }} · {{ v.label || v.kind }} · {{ fmtTime(v.created_at) }}</option></select>
        <button class="btn-secondary" @click="doDiff">对比差异</button>
      </div>
      <table>
        <thead><tr><th>版本</th><th>类型</th><th>说明</th><th>文件数</th><th>大小</th><th>操作人</th><th>时间</th><th style="width:240px">操作</th></tr></thead>
        <tbody>
          <tr v-for="v in versions" :key="v.id">
            <td class="mono">v{{ v.id }}</td>
            <td><span class="badge" :class="v.kind==='rollback'?'rollback':(v.kind==='publish'?'publish':'snapshot')">{{ v.kind }}</span></td>
            <td>{{ v.label || '-' }}</td>
            <td class="mono">{{ v.file_count }}</td>
            <td class="mono">{{ fmtSize(v.size) }}</td>
            <td>{{ v.created_by || '-' }}</td>
            <td class="mono">{{ fmtTime(v.created_at) }}</td>
            <td class="row-actions">
              <button class="btn-ghost" @click="showFiles(v)">文件清单</button>
              <button class="btn-ghost" @click="download(v)">下载</button>
              <button class="btn-danger" :disabled="locked" @click="askRollback(v)">回滚</button>
              <button class="btn-danger" :disabled="locked" @click="askDelete(v)">删除</button>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="!versions.length" class="muted" style="padding:10px">暂无版本，先去发布一次。</div>
    </div>

    <div class="card" v-if="viewFiles">
      <div class="browse-bar"><strong class="mono">v{{ viewFiles.id }} 文件清单（{{ viewFilesList.length }}）</strong><button class="btn-ghost" @click="viewFiles=null">关闭</button></div>
      <table>
        <thead><tr><th>路径</th><th style="width:100px">大小</th></tr></thead>
        <tbody><tr v-for="f in viewFilesList" :key="f.path"><td class="mono">{{ f.path }}</td><td class="mono">{{ fmtSize(f.size) }}</td></tr></tbody>
      </table>
    </div>

    <!-- 版本对比弹窗：仅按钮关闭 -->
    <div class="modal-mask" v-if="diffOpen">
      <div class="modal modal-lg">
        <div class="modal-title">版本对比：v{{ selA }} → v{{ selB }}</div>
        <diff-columns :diff="diff" />
        <div class="form-actions"><button class="btn-primary" @click="diffOpen=false">关闭</button></div>
      </div>
    </div>

    <confirm-modal
      :show="confirmState.show"
      title="确认回滚"
      :message="'确认回滚到 v' + (confirmState.version ? confirmState.version.id : '') + '？\\n将先备份当前文件，然后彻底还原为该历史版本（保护文件与排除文件不受影响）。'"
      confirm-text="确认回滚"
      danger
      :busy="confirmState.busy"
      @confirm="doRollback"
      @cancel="confirmState.show=false" />

    <confirm-modal
      :show="delState.show"
      title="确认删除版本"
      :message="'确认删除 v' + (delState.version ? delState.version.id : '') + '？\\n版本记录、文件清单与快照 zip 将一并删除，不可恢复。' + (delState.warn ? '\\n注意：这是当前最新版本，删除后无法再回滚到它（不推荐）。' : '')"
      confirm-text="确认删除"
      danger
      :busy="delState.busy"
      @confirm="doDelete"
      @cancel="delState.show=false" />
  </div>`
};

// ===== 站点设置分区：排除项 excludes / 发布不替换的文件 protect_files / 保留版本数 / 解绑 =====
const SettingsPage = {
  props: ['siteId', 'notify', 'navigate'],
  setup(props) {
    const loading = ref(true);
    const saving = ref(false);
    const form = reactive({ name: '', excludes: '', protect_files: '', keep_count: 10 });
    const confirmState = reactive({ show: false, busy: false, siteName: '' });
    const load = async () => {
      loading.value = true;
      try {
        const r = await api('/sites');
        const s = (r.sites || []).find(x => x.id === props.siteId);
        if (!s) throw new Error('站点不存在');
        Object.assign(form, {
          name: s.name,
          excludes: (s.excludes || []).join('\n'),
          protect_files: (s.protect_files || []).join('\n'),
          keep_count: s.keep_count
        });
        confirmState.siteName = s.name;
      } catch (e) { props.notify(e.message, 'err'); }
      finally { loading.value = false; }
    };
    onMounted(load);
    const save = async () => {
      saving.value = true;
      try {
        await api('/sites/' + props.siteId, {
          method: 'PUT',
          body: {
            name: form.name,
            excludes: form.excludes.split('\n').map(s => s.trim()).filter(Boolean),
            protect_files: form.protect_files.split('\n').map(s => s.trim()).filter(Boolean),
            keep_count: Number(form.keep_count)
          }
        });
        props.notify('站点设置已保存');
      } catch (e) { props.notify(e.message, 'err'); }
      finally { saving.value = false; }
    };
    const doUnbind = async () => {
      confirmState.busy = true;
      try {
        await api('/sites/' + props.siteId, { method: 'DELETE' });
        confirmState.show = false;
        props.notify('已解绑');
        props.navigate('#/sites');
      } catch (e) { props.notify(e.message, 'err'); }
      finally { confirmState.busy = false; }
    };
    return { loading, saving, form, confirmState, save, doUnbind };
  },
  template: `
  <div>
    <div class="card" v-if="!loading">
      <div class="card-head"><div class="card-title">站点设置</div></div>
      <div class="form-row"><label>站点名称</label><input v-model="form.name" /></div>
      <div class="form-row"><label>排除项 excludes（每行一个 glob，不参与快照 / 统计 / 发布）</label><textarea rows="3" v-model="form.excludes" placeholder="*.log"></textarea></div>
      <div class="form-row"><label>发布不替换的文件 protect_files（每行一个文件名，大小写不敏感；发布/回滚不覆盖、不删除）</label><textarea rows="2" v-model="form.protect_files" placeholder="web.config"></textarea></div>
      <div class="form-row"><label>保留版本数（超出自动清理旧版本快照）</label><input type="number" v-model.number="form.keep_count" min="1" /></div>
      <div class="form-actions">
        <button class="btn-primary" @click="save" :disabled="saving">{{ saving ? '保存中...' : '保存设置' }}</button>
      </div>
    </div>
    <div class="card" v-else><div class="muted">加载中...</div></div>

    <div class="card">
      <div class="card-head"><div class="card-title">危险操作</div></div>
      <p class="prose" style="margin-bottom:12px">解绑后目录内文件不会被删除，但该站点的版本记录与快照将不可见。</p>
      <button class="btn-danger" @click="confirmState.show=true">解绑站点</button>
    </div>

    <confirm-modal
      :show="confirmState.show"
      title="确认解绑"
      :message="'确认解绑「' + confirmState.siteName + '」？\\n目录内文件不会被删除，但版本快照记录将不可见。'"
      confirm-text="确认解绑"
      danger
      :busy="confirmState.busy"
      @confirm="doUnbind"
      @cancel="confirmState.show=false" />
  </div>`
};

// ===== 站点详情页外壳：标题 + 功能 tab（文件/发布/版本/设置），子路由可直达 =====
const SiteDetailPage = {
  props: ['siteId', 'tab', 'notify', 'navigate', 'fmtSize', 'fmtTime'],
  setup(props) {
    const site = ref(null);
    const tabs = [
      { key: 'files', label: '文件浏览' },
      { key: 'publish', label: '发布' },
      { key: 'versions', label: '版本历史' },
      { key: 'settings', label: '站点设置' }
    ];
    const active = computed(() => tabs.some(t => t.key === props.tab) ? props.tab : 'files');
    const loadSite = async () => {
      try {
        const r = await api('/sites');
        site.value = (r.sites || []).find(x => x.id === props.siteId) || null;
      } catch { site.value = null; }
    };
    onMounted(loadSite);
    watch(() => props.siteId, loadSite);
    const goTab = k => props.navigate('#/sites/' + props.siteId + (k === 'files' ? '/files' : '/' + k));
    return { site, tabs, active, goTab };
  },
  template: `
  <div>
    <div class="page-head">
      <div>
        <div class="eyebrow">SITE #{{ siteId }}</div>
        <div class="page-title">{{ site ? site.name : '站点 #' + siteId }}
          <span v-if="site && site.locked" class="badge lock">发布中</span>
        </div>
        <div class="mono muted" v-if="site" style="margin-top:4px">{{ site.root_path }}</div>
      </div>
      <div class="stats-inline" v-if="site">
        <span>{{ site.fileCount }} 个文件</span><span>{{ $root.fmtSize(site.totalSize) }}</span>
        <span class="stat-new" v-if="site.latest">最新 v{{ site.latest.id }}</span>
      </div>
    </div>

    <div class="detail-tabs">
      <a v-for="t in tabs" :key="t.key" :class="{ active: active === t.key }" @click.prevent="goTab(t.key)">{{ t.label }}</a>
    </div>

    <files-page v-if="active==='files'" :site-id="siteId" :notify="notify" :fmt-size="fmtSize" :navigate="navigate" />
    <publish-page v-else-if="active==='publish'" :site-id="siteId" :notify="notify" :navigate="navigate" />
    <versions-page v-else-if="active==='versions'" :site-id="siteId" :notify="notify" :fmt-size="fmtSize" :fmt-time="fmtTime" :navigate="navigate" />
    <settings-page v-else :site-id="siteId" :notify="notify" :navigate="navigate" />
  </div>`
};

const AuditPage = {
  props: ['notify', 'fmtTime'],
  setup(props) {
    const logs = ref([]);
    const action = ref('');
    const load = async () => {
      try {
        logs.value = (await api('/audit' + (action.value ? '?action=' + action.value : ''))).logs;
      } catch (e) { props.notify(e.message, 'err'); }
    };
    onMounted(load);
    return { logs, action, load };
  },
  template: `
  <div>
    <div class="page-head"><div><div class="eyebrow">AUDIT</div><div class="page-title">审计日志</div></div></div>
    <div class="card">
      <div class="browse-bar">
        <select v-model="action" @change="load">
          <option value="">全部动作</option>
          <option value="publish">发布</option>
          <option value="rollback">回滚</option>
          <option value="version.delete">删除版本</option>
          <option value="file.save">文件编辑</option>
          <option value="site.bind">绑定目录</option>
          <option value="login">登录</option>
        </select>
      </div>
      <table>
        <thead><tr><th>时间</th><th>用户</th><th>动作</th><th>站点</th><th>详情</th></tr></thead>
        <tbody>
          <tr v-for="l in logs" :key="l.id">
            <td class="mono">{{ fmtTime(l.created_at) }}</td>
            <td>{{ l.username || '-' }}</td>
            <td class="mono">{{ l.action }}</td>
            <td class="mono">{{ l.site_id || '-' }}</td>
            <td class="mono">{{ l.detail || '-' }}</td>
          </tr>
        </tbody>
      </table>
      <div v-if="!logs.length" class="muted" style="padding:10px">暂无日志</div>
    </div>
  </div>`
};

const App = {
  setup() {
    const route = ref(location.hash || '#/login');
    const user = ref(null);
    const booting = ref(true);
    const toast = reactive({ show: false, msg: '', type: 'ok' });
    const notify = (msg, type = 'ok') => {
      toast.msg = msg; toast.type = type; toast.show = true;
      setTimeout(() => (toast.show = false), 2600);
    };
    window.addEventListener('hashchange', () => (route.value = location.hash));
    const checkAuth = async () => {
      try { user.value = (await api('/auth/me')).user; }
      catch { user.value = null; }
      booting.value = false;
      if (!user.value && route.value !== '#/login') location.hash = '#/login';
      else if (user.value && route.value === '#/login') location.hash = '#/sites';
    };
    onMounted(checkAuth);
    const logout = async () => {
      try { await api('/auth/logout', { method: 'POST' }); } catch {}
      user.value = null;
      location.hash = '#/login';
    };
    const navigate = h => (location.hash = h);
    const goBack = () => history.back();
    const goForward = () => history.forward();
    const page = computed(() => {
      const h = route.value.replace(/^#/, '');
      if (h.startsWith('/login')) return 'login';
      if (h.startsWith('/audit')) return 'audit';
      // 详情页 #/sites/:id（默认 files tab）与子路由 #/sites/:id/{files,publish,versions,settings}
      const m = h.match(/^\/sites\/(\d+)(?:\/(\w+))?/);
      if (m) return { name: m[2] || 'files', id: Number(m[1]), kind: m[2] || 'files' };
      return 'sites';
    });
    // 面包屑：站点 > 详情 > 当前功能
    const siteName = ref('');
    const kindLabel = { files: '文件浏览', publish: '发布', versions: '版本历史', settings: '站点设置' };
    const crumbs = computed(() => {
      if (page.value && page.value.kind) {
        if (siteName.value === '' || siteName.value.id !== page.value.id) return null;
        return [
          { label: '站点', hash: '#/sites' },
          { label: siteName.value.name, hash: '#/sites/' + page.value.id },
          { label: kindLabel[page.value.kind] || page.value.kind, hash: null }
        ];
      }
      if (page.value === 'audit') return [{ label: '站点', hash: '#/sites' }, { label: '审计日志', hash: null }];
      return null;
    });
    const loadSiteName = async id => {
      if (siteName.value && siteName.value.id === id) return;
      try {
        const r = await api('/sites');
        const s = (r.sites || []).find(x => x.id === id);
        siteName.value = s ? { id: s.id, name: s.name } : { id, name: '站点 #' + id };
      } catch { siteName.value = { id, name: '站点 #' + id }; }
    };
    watch(page, p => { if (p && p.kind) loadSiteName(p.id); else siteName.value = ''; }, { immediate: true });
    const loginForm = reactive({ username: '', password: '', loading: false });
    const doLogin = async () => {
      loginForm.loading = true;
      try {
        const r = await api('/auth/login', { method: 'POST', body: { username: loginForm.username, password: loginForm.password } });
        user.value = r.user;
        location.hash = '#/sites';
      } catch (e) { notify(e.message, 'err'); }
      finally { loginForm.loading = false; }
    };
    return { route, user, booting, toast, notify, navigate, goBack, goForward, logout, page, crumbs, siteName, loginForm, doLogin, fmtSize, fmtTime };
  },
  template: `
  <div v-if="booting" class="login-wrap"><div class="muted">加载中...</div></div>
  <div v-else-if="!user || page==='login'" class="login-wrap">
    <form class="login-card" @submit.prevent="doLogin">
      <div class="eyebrow">FILE PROXY · IIS</div>
      <h2>文件版本管理</h2>
      <p class="prose">发布前先看差异，再确认上线。</p>
      <div class="form-row"><label>用户名</label><input v-model="loginForm.username" placeholder="用户名" autocomplete="username" /></div>
      <div class="form-row"><label>密码</label><input v-model="loginForm.password" type="password" placeholder="密码" autocomplete="current-password" /></div>
      <button class="btn-primary" :disabled="loginForm.loading">{{ loginForm.loading ? '登录中...' : '登 录' }}</button>
    </form>
    <div v-if="toast.show" class="toast" :class="toast.type">{{ toast.msg }}</div>
  </div>
  <div v-else class="layout">
    <nav class="sidebar">
      <div class="brand">文件版本管理<span class="brand-sub">IIS 发布台</span></div>
      <a :class="{active: page==='sites'}" @click.prevent="navigate('#/sites')">站点</a>
      <a :class="{active: page==='audit'}" @click.prevent="navigate('#/audit')">审计日志</a>
      <div class="side-nav" v-if="page && page.kind">
        <div class="side-nav-title">当前站点</div>
        <a @click.prevent="navigate('#/sites/' + page.id)" :class="{active: page.kind==='files'}">站点详情 / 文件浏览</a>
        <a @click.prevent="navigate('#/sites/' + page.id + '/publish')" :class="{active: page.kind==='publish'}">发布</a>
        <a @click.prevent="navigate('#/sites/' + page.id + '/versions')" :class="{active: page.kind==='versions'}">版本历史</a>
        <a @click.prevent="navigate('#/sites/' + page.id + '/settings')" :class="{active: page.kind==='settings'}">站点设置</a>
      </div>
      <div class="side-foot"><a @click.prevent="logout">退出 ({{ user.username }})</a></div>
    </nav>
    <main class="main">
      <div class="topbar" v-if="crumbs">
        <div class="breadcrumb">
          <template v-for="(c, i) in crumbs" :key="i">
            <span v-if="i > 0" class="crumb-sep">/</span>
            <a v-if="c.hash" @click.prevent="navigate(c.hash)">{{ c.label }}</a>
            <span v-else class="crumb-current">{{ c.label }}</span>
          </template>
        </div>
        <div class="topbar-actions">
          <button class="btn-ghost nav-btn" @click="goBack" title="后退">← 后退</button>
          <button class="btn-ghost nav-btn" @click="goForward" title="前进">前进 →</button>
        </div>
      </div>
      <sites-page v-if="page==='sites'" :notify="notify" :fmt-size="fmtSize" :fmt-time="fmtTime" :navigate="navigate" />
      <site-detail-page v-else-if="page && page.kind" :site-id="page.id" :tab="page.kind" :notify="notify" :fmt-size="fmtSize" :fmt-time="fmtTime" :navigate="navigate" />
      <audit-page v-else-if="page==='audit'" :notify="notify" :fmt-time="fmtTime" />
    </main>
    <div v-if="toast.show" class="toast" :class="toast.type">{{ toast.msg }}</div>
  </div>`
};

createApp(App)
  .component('sites-page', SitesPage)
  .component('site-detail-page', SiteDetailPage)
  .component('settings-page', SettingsPage)
  .component('files-page', FilesPage)
  .component('publish-page', PublishPage)
  .component('versions-page', VersionsPage)
  .component('audit-page', AuditPage)
  .component('confirm-modal', ConfirmModal)
  .component('diff-columns', DiffColumns)
  .mount('#app');