/* ============================================================
 * GH Artifact Proxy — GitHub Actions Artifacts 加速下载
 * 纯静态实现（无构建、无第三方依赖），可直接部署到 GitHub Pages。
 *
 * 工作原理：
 *  1. 解析用户粘贴的 Workflow Run 链接，得到 owner / repo / run_id；
 *  2. 浏览器直接请求 api.github.com（已开启 CORS）读取 Run 与 Artifact 列表；
 *  3. 公有仓库：下载链接经社区代理前缀加速；
 *     私有仓库：携带 Token 由浏览器直连下载（Azure CDN），带进度显示。
 * ============================================================ */
'use strict';

/* ---------- 可配置项 ---------- */

/** 部署后请改成你自己的仓库地址；留空则隐藏右上角入口 */
const CONFIG = {
  repoUrl: 'https://github.com/lindedaoqwq/gh-artifact-proxy',
};

/**
 * 加速下载全部走 gh-proxy.com 提供的线路（详见 https://gh-proxy.com）。
 * prefix 为 '' 表示直连；'__auto__' 表示自动测速选最快；'__custom__' 表示用户输入的自定义代理。
 * 仅 probe: true 的线路参与「自动选择最快线路」的测速。
 */
const PROXIES = [
  { name: '自动选择最快线路', prefix: '__auto__', probe: false },
  { name: 'gh-proxy.org（Cloudflare）', prefix: 'https://gh-proxy.org/', probe: true },
  { name: 'v4.gh-proxy.org（Cloudflare 推荐）', prefix: 'https://v4.gh-proxy.org/', probe: true },
  { name: 'v6.gh-proxy.org（Cloudflare v4/v6）', prefix: 'https://v6.gh-proxy.org/', probe: true },
  { name: 'cdn.gh-proxy.org（Fastly）', prefix: 'https://cdn.gh-proxy.org/', probe: true },
  { name: 'axisnow.gh-proxy.org（AxisNow）', prefix: 'https://axisnow.gh-proxy.org/', probe: true },
  { name: '自定义代理…', prefix: '__custom__', probe: false },
];

const LS_KEYS = {
  schema: 'ghap.schema',
  token: 'ghap.token',
  proxyIndex: 'ghap.proxyIndex',
  customProxy: 'ghap.customProxy',
  apiViaProxy: 'ghap.apiViaProxy',
  downloadMode: 'ghap.downloadMode',
  history: 'ghap.history',
};
const PROXY_SCHEMA = 2; // 代理列表结构版本，变更时重置相关偏好

const state = {
  owner: '',
  repo: '',
  runId: '',
  run: null,
  artifacts: [],
  token: '',
  proxyIndex: 0,
  customProxy: '',
  apiViaProxy: false,
  downloadMode: 'auto', // auto | proxy | direct
  autoRoute: '',        // 自动模式下测速选出的更快线路前缀
  rateLimit: null,
  loading: false,
};

/* ---------- 内联 SVG 图标 ---------- */

const ICON_DOWNLOAD =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="m7 11 5 5 5-5"/><path d="M4 20h16"/></svg>';
const ICON_LINK =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.07 0l2.83-2.83a5 5 0 0 0-7.07-7.07L11 4.93"/><path d="M14 11a5 5 0 0 0-7.07 0L4.1 13.83a5 5 0 0 0 7.07 7.07L13 19.07"/></svg>';
const ICON_BOX =
  '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 8.5 12 3 3 8.5v7L12 21l9-5.5v-7z"/><path d="M3 8.5 12 14l9-5.5"/><path d="M12 14v7"/></svg>';

/* ---------- 纯工具函数（可在 Node 下单测） ---------- */

const $ = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** 解析各种格式的 Workflow Run 链接，返回 { owner, repo, runId } 或 null */
function parseRunUrl(input) {
  const text = String(input == null ? '' : input).trim();
  if (!text) return null;
  const patterns = [
    /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/actions\/runs\/(\d+)/i,
    /^https?:\/\/api\.github\.com\/repos\/([^/\s]+)\/([^/\s]+)\/actions\/runs\/(\d+)/i,
    /^github\.com\/([^/\s]+)\/([^/\s]+)\/actions\/runs\/(\d+)/i,
    /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(\d+)$/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return { owner: m[1], repo: m[2].replace(/\.git$/i, ''), runId: m[3] };
  }
  return null;
}

function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '-';
  if (n === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return (i === 0 ? v.toFixed(0) : v.toFixed(1)) + ' ' + units[i];
}

function formatDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* ---------- 代理与下载方式 ---------- */

function clampProxyIndex(i) {
  return Number.isInteger(i) && i >= 0 && i < PROXIES.length ? i : 0;
}

/** 参与自动测速的线路前缀列表 */
function probeRoutePrefixes() {
  return PROXIES.filter((p) => p.probe).map((p) => p.prefix);
}

/** 默认线路：列表中的第一个 gh-proxy 线路（测速未完成时回退使用） */
function defaultRoutePrefix() {
  const r = PROXIES.find((p) => /^https?:\/\//i.test(p.prefix));
  return r ? r.prefix : '';
}

/** 由代理前缀取简短主机名，用于展示（如 https://gh-proxy.org/ → gh-proxy.org） */
function hostOf(prefix) {
  try { return new URL(prefix).host; } catch (_) { return String(prefix); }
}

function currentProxyPrefix() {
  const p = PROXIES[clampProxyIndex(state.proxyIndex)] || PROXIES[0];
  if (p.prefix === '__auto__') return state.autoRoute || defaultRoutePrefix();
  if (p.prefix === '__custom__') {
    let v = String(state.customProxy || '').trim();
    if (!v) return '';
    if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
    return v.replace(/\/+$/, '') + '/';
  }
  return p.prefix;
}

function currentProxyName() {
  const p = PROXIES[clampProxyIndex(state.proxyIndex)] || PROXIES[0];
  if (p.prefix === '__auto__') {
    if (state.autoRoute) return '自动（' + hostOf(state.autoRoute) + '）';
    return '自动选择最快线路';
  }
  if (p.prefix === '__custom__') return state.customProxy ? '自定义代理' : '直连';
  return p.prefix ? p.name : '直连';
}

/** 生成加速下载链接：代理前缀 + 原始 URL */
function buildProxiedUrl(target) {
  const prefix = currentProxyPrefix();
  return prefix ? prefix + target : target;
}

/** auto 模式：有 Token 走直连（代理无法认证），否则走代理 */
function effectiveMode() {
  if (state.downloadMode === 'proxy') return 'proxy';
  if (state.downloadMode === 'direct') return 'direct';
  return state.token ? 'direct' : 'proxy';
}

function downloadModeName() {
  if (state.downloadMode === 'proxy') return `总是走代理（${currentProxyName()}）`;
  if (state.downloadMode === 'direct') return '总是直连';
  return state.token ? '直连（已填写 Token）' : `代理（${currentProxyName()}）`;
}

/* ---------- 自动测速选最快线路 ---------- */

let routeLatencies = {};  // prefix -> 延迟(ms)；失败/超时置为 null
let routeProbing = false;

async function probeRoutes() {
  const routes = PROXIES.filter((p) => p.probe);
  if (!routes.length) return;
  routeProbing = true;
  renderRouteProbe();
  const target = 'https://api.github.com/rate_limit'; // 小体积 JSON，专用于测速
  const results = await Promise.allSettled(routes.map(async (r) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const start = performance.now();
    try {
      const res = await fetch(r.prefix + target, { signal: ctrl.signal, cache: 'no-store', mode: 'cors' });
      const ms = Math.round(performance.now() - start);
      return { prefix: r.prefix, ok: res.ok, ms: res.ok ? ms : null };
    } catch (_) {
      return { prefix: r.prefix, ok: false, ms: null };
    } finally {
      clearTimeout(timer);
    }
  }));

  const alive = [];
  routes.forEach((r, i) => {
    const val = results[i].status === 'fulfilled' ? results[i].value : { ok: false };
    if (val && val.ok) {
      routeLatencies[r.prefix] = val.ms;
      alive.push({ prefix: r.prefix, ms: val.ms });
    } else {
      routeLatencies[r.prefix] = null;
    }
  });
  alive.sort((a, b) => a.ms - b.ms);
  state.autoRoute = alive.length ? alive[0].prefix : defaultRoutePrefix();
  routeProbing = false;
  renderRouteProbe();
  if (state.artifacts.length) refreshArtifactLinks();
}

/** 渲染「线路测速」面板（仅自动模式可见） */
function renderRouteProbe() {
  const wrap = $('route-probe');
  if (!wrap) return;
  const p = PROXIES[clampProxyIndex(state.proxyIndex)] || PROXIES[0];
  const show = p.prefix === '__auto__';
  wrap.hidden = !show;
  if (!show) return;
  const list = $('route-probe-list');
  if (!list) return;
  const routes = PROXIES.filter((x) => x.probe);
  if (routeProbing && !Object.keys(routeLatencies).length) {
    list.innerHTML = '<li class="route-item probing">测速中…</li>';
    return;
  }
  list.innerHTML = routes.map((r) => {
    const ms = routeLatencies[r.prefix];
    const isBest = state.autoRoute && state.autoRoute === r.prefix;
    const cls = ms == null ? 'down' : 'up';
    const label = ms == null ? '不可用' : (ms + ' ms');
    const badge = isBest ? ' <span class="route-best">最快</span>' : '';
    return `<li class="route-item ${cls}${isBest ? ' is-best' : ''}">`
      + `<span class="route-dot"></span>`
      + `<span class="route-host">${escapeHtml(hostOf(r.prefix))}</span>${badge}`
      + `<span class="route-ms">${label}</span>`
      + `</li>`;
  }).join('');
}

/* ---------- GitHub API ---------- */

function apiUrl(path) {
  const base = 'https://api.github.com' + path;
  if (state.apiViaProxy) {
    const prefix = currentProxyPrefix();
    if (prefix) return prefix + base;
  }
  return base;
}

async function ghApi(path) {
  const url = apiUrl(path);
  const headers = { Accept: 'application/vnd.github+json' };
  // 开启「API 走代理」时禁止携带 Token，避免 Token 经过代理服务器
  if (state.token && !state.apiViaProxy) headers.Authorization = 'Bearer ' + state.token;

  let res;
  try {
    res = await fetch(url, { headers });
  } catch (e) {
    const err = new Error('无法连接 api.github.com');
    err.name = 'TypeError';
    throw err;
  }

  if (!state.apiViaProxy) updateRateLimit(res.headers);

  if (res.status === 404) {
    const err = new Error('Not Found');
    err.code = 404;
    throw err;
  }
  if (!res.ok) {
    let msg = 'HTTP ' + res.status;
    try {
      const body = await res.json();
      if (body && body.message) msg = body.message;
    } catch (_) { /* 忽略解析失败 */ }
    const err = new Error(msg);
    err.code = res.status;
    throw err;
  }
  try {
    return await res.json();
  } catch (_) {
    const err = new Error('响应不是有效的 JSON（当前代理可能不支持 API 请求，请更换代理或关闭「API 走代理」）');
    err.code = res.status;
    throw err;
  }
}

function updateRateLimit(headers) {
  const remaining = headers.get('x-ratelimit-remaining');
  if (remaining == null) return;
  const limit = headers.get('x-ratelimit-limit');
  const reset = headers.get('x-ratelimit-reset');
  state.rateLimit = {
    remaining: Number(remaining),
    limit: limit ? Number(limit) : null,
    reset: reset ? Number(reset) * 1000 : null,
  };
  renderRateLimit();
}

function renderRateLimit() {
  const el = $('rate-limit');
  if (!el) return;
  const rl = state.rateLimit;
  if (!rl || state.apiViaProxy) { el.textContent = ''; return; }
  let text = `GitHub API 剩余额度 ${rl.remaining}${rl.limit ? '/' + rl.limit : ''}`;
  if (rl.remaining === 0 && rl.reset) {
    text += `，${new Date(rl.reset).toLocaleTimeString('zh-CN')} 重置`;
  }
  el.textContent = text;
}

/* ---------- 状态提示 ---------- */

let statusTimer = 0;

function showStatus(type, msg, autoHideMs = 0) {
  const el = $('status');
  if (!el) return;
  el.hidden = false;
  el.className = 'status status-' + type;
  el.innerHTML = (type === 'loading' ? '<span class="spinner"></span>' : '') +
    '<span>' + escapeHtml(msg) + '</span>';
  window.clearTimeout(statusTimer);
  if (autoHideMs > 0) {
    statusTimer = window.setTimeout(() => { el.hidden = true; }, autoHideMs);
  }
}

function hideStatus() {
  const el = $('status');
  if (el) el.hidden = true;
  window.clearTimeout(statusTimer);
}

function hidePanels() {
  $('run-panel').hidden = true;
  $('artifacts-panel').hidden = true;
}

function setLoading(v) {
  state.loading = v;
  const btn = $('parse-btn');
  if (!btn) return;
  btn.disabled = v;
  btn.textContent = v ? '解析中…' : '解析';
}

/* ---------- 核心流程 ---------- */

async function loadRun() {
  if (state.loading) return;

  const raw = $('run-url').value.trim();
  if (!raw) {
    showStatus('error', '请先粘贴 GitHub Actions Workflow Run 链接');
    $('run-url').focus();
    return;
  }
  const parsed = parseRunUrl(raw);
  if (!parsed) {
    showStatus('error', '无法识别该链接。支持格式：https://github.com/owner/repo/actions/runs/1234567890 或 owner/repo/1234567890');
    return;
  }
  if (state.apiViaProxy && state.token) {
    showStatus('error', '「API 请求也走代理」与「Token」不能同时使用（避免 Token 经过代理泄露），请二选一。');
    return;
  }

  state.owner = parsed.owner;
  state.repo = parsed.repo;
  state.runId = parsed.runId;

  hidePanels();
  setLoading(true);
  showStatus('loading', '正在读取 Run 与 Artifact 列表…');

  try {
    const [run, arts] = await Promise.all([
      ghApi(`/repos/${parsed.owner}/${parsed.repo}/actions/runs/${parsed.runId}`),
      ghApi(`/repos/${parsed.owner}/${parsed.repo}/actions/runs/${parsed.runId}/artifacts?per_page=100`),
    ]);
    state.run = run;
    state.artifacts = Array.isArray(arts.artifacts) ? arts.artifacts : [];
    renderRun(run);
    renderArtifacts();
    pushHistory(parsed);
    showStatus(
      'info',
      state.artifacts.length ? `读取成功，共 ${state.artifacts.length} 个 Artifact` : '读取成功，但该 Run 下没有 Artifact',
      4000,
    );
  } catch (err) {
    handleApiError(err);
  } finally {
    setLoading(false);
  }
}

function handleApiError(err) {
  const code = err && err.code;
  if (code === 404) {
    showStatus('error', '未找到对应的 Run（404）。可能原因：链接不正确；仓库为私有但未填写 Token；或该 Run 已被删除。');
  } else if (code === 401) {
    showStatus('error', 'GitHub 返回 401：Token 无效、过期或权限不足，请检查后重试。');
  } else if (code === 403) {
    const rl = state.rateLimit;
    if (rl && rl.remaining === 0 && rl.reset) {
      showStatus('error', `GitHub API 额度已用尽，将于 ${new Date(rl.reset).toLocaleTimeString('zh-CN')} 重置。可填写 Token 将限额提升到 5000 次/小时。`);
    } else {
      showStatus('error', '访问被拒绝（403）：' + ((err && err.message) || '权限不足或被安全策略拦截'));
    }
  } else if (err && err.name === 'TypeError') {
    showStatus('error', '网络请求失败：无法连接 api.github.com。若所在网络无法直接访问，可在高级选项中开启「API 请求也走代理」（仅公有仓库）。');
  } else {
    showStatus('error', (err && err.message) || '发生未知错误，请重试。');
  }
}

/* ---------- 渲染：Run 信息 ---------- */

function renderRun(run) {
  $('run-panel').hidden = false;
  $('run-number').textContent = run.run_number != null ? '#' + run.run_number : '#' + run.id;

  const badge = $('run-status');
  const st = run.status || '';
  const cc = run.conclusion || '';
  badge.textContent = st === 'completed' ? (cc || 'completed') : (st || 'unknown');
  badge.className = 'run-status ' + (
    st !== 'completed' ? 'is-pending' : cc === 'success' ? 'is-success' : cc ? 'is-failure' : 'is-neutral'
  );

  const fullName = (run.head_repository && run.head_repository.full_name) ||
    (run.repository && run.repository.full_name) ||
    (state.owner + '/' + state.repo);
  const sha = run.head_sha || '';
  const items = [
    ['工作流', escapeHtml(run.name || '-')],
    ['仓库', `<a href="https://github.com/${escapeHtml(fullName)}" target="_blank" rel="noopener">${escapeHtml(fullName)}</a>`],
    ['分支', escapeHtml(run.head_branch || '-')],
    ['提交', sha ? `<a href="https://github.com/${escapeHtml(fullName)}/commit/${escapeHtml(sha)}" target="_blank" rel="noopener"><code>${escapeHtml(sha.slice(0, 7))}</code></a>` : '-'],
    ['标题', escapeHtml(run.display_title || (run.head_commit && run.head_commit.message) || '-')],
    ['触发方式', escapeHtml((run.event || '-') + (run.actor && run.actor.login ? ' · ' + run.actor.login : ''))],
    ['创建时间', escapeHtml(formatDate(run.created_at))],
  ];
  if (run.run_attempt && run.run_attempt > 1) items.push(['尝试次数', '第 ' + run.run_attempt + ' 次']);

  $('run-meta').innerHTML = items
    .map(([k, v]) => `<div class="meta-item"><dt>${k}</dt><dd>${v}</dd></div>`)
    .join('');
}

/* ---------- 渲染：Artifact 列表 ---------- */

function renderArtifacts() {
  $('artifacts-panel').hidden = false;
  $('artifact-count').textContent = String(state.artifacts.length);
  $('proxy-indicator').textContent = state.artifacts.length ? '下载方式：' + downloadModeName() : '';

  const list = $('artifact-list');
  list.innerHTML = '';
  if (!state.artifacts.length) {
    list.innerHTML = '<p class="empty">该 Run 暂无可下载的 Artifact。</p>';
    return;
  }
  const frag = document.createDocumentFragment();
  state.artifacts.forEach((a) => frag.appendChild(buildArtifactItem(a)));
  list.appendChild(frag);
}

function buildArtifactItem(artifact) {
  const el = document.createElement('article');
  el.className = 'artifact-item' + (artifact.expired ? ' is-expired' : '');
  el.dataset.artifactId = String(artifact.id);

  el.innerHTML = `
    <div class="artifact-icon">${ICON_BOX}</div>
    <div class="artifact-info">
      <h3 class="artifact-name">${escapeHtml(artifact.name)}.zip</h3>
      <p class="artifact-sub">
        <span>${formatBytes(artifact.size_in_bytes)}</span><i>·</i>
        <span>创建于 ${escapeHtml(formatDate(artifact.created_at))}</span><i>·</i>
        <span>${artifact.expired ? '<b class="expired-tag">已过期</b>' : '过期于 ' + escapeHtml(formatDate(artifact.expires_at))}</span>
      </p>
    </div>
    <div class="artifact-actions">
      <a class="btn btn-primary" data-action="download" role="button">${ICON_DOWNLOAD}下载</a>
      <button class="btn btn-ghost" type="button" data-action="copy">${ICON_LINK}复制链接</button>
    </div>`;

  // 事件统一由 #artifact-list 上的委托监听处理（见 initArtifactListDelegation），
  // 这样即使列表因切换 Token / 代理而重渲染，点击依然有效。
  applyArtifactLinkState(el, artifact);
  return el;
}

/**
 * 将 artifact 的下载按钮状态同步到 DOM（新建与就地刷新共用）。
 * 不销毁/重建节点，保证进行中的点击事件不被打断。
 */
function applyArtifactLinkState(el, artifact) {
  const dl = el.querySelector('[data-action="download"]');
  if (!dl) return;
  if (artifact.expired) {
    dl.classList.add('is-disabled');
    dl.setAttribute('aria-disabled', 'true');
    dl.removeAttribute('href');
    dl.removeAttribute('target');
    dl.removeAttribute('rel');
    dl.title = '该 Artifact 已过期，无法下载';
  } else if (effectiveMode() === 'direct') {
    dl.classList.remove('is-disabled');
    dl.removeAttribute('aria-disabled');
    dl.removeAttribute('href');
    dl.removeAttribute('target');
    dl.removeAttribute('rel');
    dl.title = '浏览器直连下载' + (state.token ? '（携带 Token）' : '（匿名，仅公有仓库）');
  } else {
    const url = buildProxiedUrl(artifact.archive_download_url);
    dl.classList.remove('is-disabled');
    dl.removeAttribute('aria-disabled');
    dl.href = url;
    dl.target = '_blank';
    dl.rel = 'noopener';
    dl.title = '经代理下载：' + url;
  }
}

/**
 * 就地刷新 artifact 下载链接（切换 Token / 代理 / 下载方式时调用）。
 *
 * 为什么不重建列表：填写 Token 后点击下载按钮时，mousedown 会令 Token 输入框
 * 失焦并触发 change → 若此时整表重建，click 事件的目标节点已被销毁、
 * 无法冒泡到委托容器，导致第一次点击被吞（用户需点两次）。就地更新可彻底
 * 避免该问题，同时保留滚动位置、更省性能。
 */
function refreshArtifactLinks() {
  const list = $('artifact-list');
  const items = Array.from(list.querySelectorAll('.artifact-item'));
  const inSync = items.length === state.artifacts.length
    && items.every((el, i) => el.dataset.artifactId === String(state.artifacts[i].id));
  if (!inSync) {
    renderArtifacts(); // DOM 与状态不一致（如空态），退回整表重渲染
    return;
  }
  items.forEach((el, i) => applyArtifactLinkState(el, state.artifacts[i]));
  $('proxy-indicator').textContent = state.artifacts.length ? '下载方式：' + downloadModeName() : '';
}

/* ---------- Artifact 列表交互（事件委托） ---------- */

function initArtifactListDelegation() {
  $('artifact-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn || !$('artifact-list').contains(btn)) return;
    const item = btn.closest('.artifact-item');
    if (!item) return;
    const artifact = state.artifacts.find((a) => String(a.id) === item.dataset.artifactId);
    if (!artifact) return;

    if (btn.dataset.action === 'copy') {
      copyText(buildProxiedUrl(artifact.archive_download_url));
      return;
    }
    // data-action === 'download'
    if (artifact.expired) return;
    if (effectiveMode() === 'direct') {
      // 直连模式：阻止默认行为，改用 fetch + Blob 下载（带进度）
      e.preventDefault();
      downloadDirect(artifact);
    }
    // 代理模式：<a href> 由浏览器原生处理，无需干预
  });
}

/* ---------- 下载：直连（fetch + Blob，带进度） ---------- */

async function downloadDirect(artifact) {
  const filename = artifact.name + '.zip';
  const overlay = openProgress(filename);
  const ctrl = new AbortController();
  overlay.onCancel = () => ctrl.abort();

  try {
    const headers = { Accept: 'application/vnd.github+json' };
    if (state.token) headers.Authorization = 'Bearer ' + state.token;

    const res = await fetch(artifact.archive_download_url, { headers, signal: ctrl.signal });
    if (!res.ok) {
      let detail = '';
      try {
        const body = await res.text();
        if (body) detail = '：' + body.slice(0, 120);
      } catch (_) { /* 忽略 */ }
      throw new Error(`GitHub 返回 ${res.status}${detail}`);
    }

    const total = Number(res.headers.get('content-length') || 0);
    let blob;
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      const chunks = [];
      let received = 0;
      for (;;) {
        const step = await reader.read();
        if (step.done) break;
        chunks.push(step.value);
        received += step.value.length;
        overlay.update(received, total);
      }
      blob = new Blob(chunks);
    } else {
      blob = await res.blob();
      overlay.update(blob.size, total || blob.size);
    }

    saveBlob(blob, filename);
    overlay.finish();
  } catch (err) {
    if (err && err.name === 'AbortError') {
      overlay.aborted();
    } else {
      overlay.fail(err);
    }
  }
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/* ---------- 下载进度浮层 ---------- */

let progressTimer = 0;

function openProgress(filename) {
  const ov = $('progress-overlay');
  window.clearTimeout(progressTimer);
  $('progress-filename').textContent = filename;
  $('progress-bar').style.width = '0%';
  $('progress-pct').textContent = '0%';
  $('progress-sizes').textContent = '';
  const msg = $('progress-msg');
  msg.textContent = '';
  msg.className = 'progress-msg';
  $('progress-cancel').hidden = false;
  $('progress-close').hidden = true;
  ov.hidden = false;

  const api = {
    onCancel: null,
    _timer: 0,
    update(received, total) {
      const pct = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : null;
      $('progress-bar').style.width = (pct == null ? 0 : pct) + '%';
      $('progress-pct').textContent = pct == null ? formatBytes(received) : pct + '%';
      $('progress-sizes').textContent = total > 0
        ? `${formatBytes(received)} / ${formatBytes(total)}`
        : formatBytes(received);
    },
    _settle(text, ok) {
      if (ok) $('progress-bar').style.width = '100%';
      $('progress-pct').textContent = ok ? '100%' : '—';
      const m = $('progress-msg');
      m.textContent = text;
      m.className = 'progress-msg ' + (ok ? 'ok' : 'err');
      $('progress-cancel').hidden = true;
      $('progress-close').hidden = false;
      window.clearTimeout(api._timer);
      if (ok) progressTimer = window.setTimeout(closeProgress, 1500);
    },
    finish() { api._settle('下载完成', true); },
    aborted() { api._settle('已取消下载', false); },
    fail(err) {
      let text = (err && err.message) || '未知错误';
      if (err && err.name === 'TypeError') {
        text += '（网络错误或 CORS 受限，可尝试将下载方式切换为「总是走代理」）';
      }
      api._settle('下载失败：' + text, false);
    },
  };

  $('progress-cancel').onclick = () => { if (api.onCancel) api.onCancel(); };
  $('progress-close').onclick = closeProgress;
  return api;
}

function closeProgress() {
  window.clearTimeout(progressTimer);
  $('progress-overlay').hidden = true;
}

/* ---------- 复制与 Toast ---------- */

async function copyText(text) {
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
    ta.remove();
  }
  toast(ok ? '链接已复制到剪贴板' : '复制失败，请手动复制');
}

let toastTimer = 0;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove('show'), 2200);
}

/* ---------- 最近解析记录 ---------- */

function getHistory() {
  try {
    const arr = JSON.parse(localStorage.getItem(LS_KEYS.history) || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch (_) {
    return [];
  }
}

function pushHistory(parsed) {
  const key = `${parsed.owner}/${parsed.repo}#${parsed.runId}`;
  const hist = getHistory().filter((h) => h && h.key !== key);
  hist.unshift({ key, owner: parsed.owner, repo: parsed.repo, runId: parsed.runId, t: Date.now() });
  try {
    localStorage.setItem(LS_KEYS.history, JSON.stringify(hist.slice(0, 8)));
  } catch (_) { /* 存储失败时静默忽略 */ }
  renderHistory();
}

function renderHistory() {
  const box = $('history');
  if (!box) return;
  const hist = getHistory();
  if (!hist.length) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  box.hidden = false;
  box.innerHTML = '<span class="history-label">最近解析：</span>';
  hist.forEach((h) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = `${h.owner}/${h.repo} #${h.runId}`;
    chip.title = '点击重新加载';
    chip.addEventListener('click', () => {
      $('run-url').value = `https://github.com/${h.owner}/${h.repo}/actions/runs/${h.runId}`;
      loadRun();
    });
    box.appendChild(chip);
  });
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'chip chip-clear';
  clear.textContent = '清空';
  clear.addEventListener('click', () => {
    try { localStorage.removeItem(LS_KEYS.history); } catch (_) { /* 忽略 */ }
    renderHistory();
  });
  box.appendChild(clear);
}

/* ---------- 初始化 ---------- */

function init() {
  // 仓库链接
  const repoLink = $('repo-link');
  if (CONFIG.repoUrl) {
    repoLink.href = CONFIG.repoUrl;
    repoLink.hidden = false;
  } else {
    repoLink.hidden = true;
  }

  // 恢复本地设置（代理列表结构变更时重置代理偏好）
  try {
    const schema = Number(localStorage.getItem(LS_KEYS.schema) || '0');
    if (schema !== PROXY_SCHEMA) {
      state.proxyIndex = 0; // 默认：自动选择最快线路
      state.customProxy = '';
      try {
        localStorage.setItem(LS_KEYS.proxyIndex, '0');
        localStorage.removeItem(LS_KEYS.customProxy);
        localStorage.setItem(LS_KEYS.schema, String(PROXY_SCHEMA));
      } catch (_) { /* 忽略 */ }
    } else {
      state.proxyIndex = clampProxyIndex(Number(localStorage.getItem(LS_KEYS.proxyIndex)));
      state.customProxy = localStorage.getItem(LS_KEYS.customProxy) || '';
    }
    state.token = (localStorage.getItem(LS_KEYS.token) || '').trim();
    state.apiViaProxy = localStorage.getItem(LS_KEYS.apiViaProxy) === '1';
    state.downloadMode = localStorage.getItem(LS_KEYS.downloadMode) || 'auto';
  } catch (_) { /* 隐私模式等场景下忽略 */ }

  // 输入区
  const urlInput = $('run-url');
  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadRun();
  });
  urlInput.addEventListener('paste', () => {
    window.setTimeout(() => {
      const v = urlInput.value.trim();
      if (/^https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/actions\/runs\/\d+/i.test(v)) loadRun();
    }, 0);
  });
  $('parse-btn').addEventListener('click', loadRun);

  // 快捷示例：点击填入输入框
  document.querySelectorAll('.example-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      urlInput.value = chip.dataset.example || '';
      urlInput.focus();
    });
  });

  // Token
  const tokenInput = $('token');
  tokenInput.value = state.token;
  const normalizeToken = () => {
    let v = tokenInput.value.trim().replace(/^(bearer|token)\s+/i, '');
    tokenInput.value = v;
    state.token = v;
    try { localStorage.setItem(LS_KEYS.token, v); } catch (_) { /* 忽略 */ }
    refreshArtifactLinks(); // 切换下载模式（就地刷新，不重建列表）
  };
  tokenInput.addEventListener('input', normalizeToken);
  tokenInput.addEventListener('change', normalizeToken);
  $('token-toggle').addEventListener('click', () => {
    const show = tokenInput.type === 'password';
    tokenInput.type = show ? 'text' : 'password';
    $('token-toggle').textContent = show ? '隐藏' : '显示';
  });
  $('token-clear').addEventListener('click', () => {
    tokenInput.value = '';
    normalizeToken();
    toast('已清除 Token');
  });

  // 代理选择
  const sel = $('proxy-select');
  PROXIES.forEach((p, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = p.name;
    sel.appendChild(opt);
  });
  sel.value = String(state.proxyIndex);
  const customInput = $('proxy-custom');
  customInput.value = state.customProxy;
  const syncProxyVisibility = () => {
    const p = PROXIES[clampProxyIndex(state.proxyIndex)];
    customInput.hidden = !(p && p.prefix === '__custom__');
    renderRouteProbe();
  };
  syncProxyVisibility();
  sel.addEventListener('change', () => {
    state.proxyIndex = clampProxyIndex(Number(sel.value));
    try { localStorage.setItem(LS_KEYS.proxyIndex, String(state.proxyIndex)); } catch (_) { /* 忽略 */ }
    syncProxyVisibility();
    if (PROXIES[state.proxyIndex].prefix === '__auto__') probeRoutes();
    refreshArtifactLinks();
  });
  customInput.addEventListener('input', () => {
    state.customProxy = customInput.value.trim();
    try { localStorage.setItem(LS_KEYS.customProxy, state.customProxy); } catch (_) { /* 忽略 */ }
    refreshArtifactLinks();
  });
  // 重新测速按钮
  const probeBtn = $('route-probe-btn');
  if (probeBtn) probeBtn.addEventListener('click', () => { routeLatencies = {}; probeRoutes(); });
  // 默认/恢复为自动线路时，自动测速一次
  if (PROXIES[clampProxyIndex(state.proxyIndex)].prefix === '__auto__') probeRoutes();

  // 下载方式
  const radios = document.querySelectorAll('input[name="download-mode"]');
  radios.forEach((r) => {
    r.checked = r.value === state.downloadMode;
    r.addEventListener('change', () => {
      if (!r.checked) return;
      state.downloadMode = r.value;
      try { localStorage.setItem(LS_KEYS.downloadMode, r.value); } catch (_) { /* 忽略 */ }
      refreshArtifactLinks();
    });
  });

  // API 走代理
  const apiVia = $('api-via-proxy');
  apiVia.checked = state.apiViaProxy;
  apiVia.addEventListener('change', () => {
    state.apiViaProxy = apiVia.checked;
    try { localStorage.setItem(LS_KEYS.apiViaProxy, apiVia.checked ? '1' : '0'); } catch (_) { /* 忽略 */ }
    renderRateLimit();
  });

  // Artifact 列表点击委托
  initArtifactListDelegation();

  renderHistory();
  renderRateLimit();
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', init);
}

/* Node 环境下导出纯函数，便于测试 */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parseRunUrl, formatBytes, formatDate, buildProxiedUrl, escapeHtml, PROXIES, state,
    currentProxyPrefix, currentProxyName, probeRoutePrefixes, defaultRoutePrefix, hostOf,
  };
}
