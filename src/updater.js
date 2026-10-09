/**
 * updater.js — 应用内自动更新
 *
 * 流程：启动后延迟静默检查 → 有新版本显示顶部提示条 → 用户点「立即更新」
 *      → 下载（带进度）→ 校验签名并安装 → 自动重启到新版本
 *
 * 为什么用官方 updater 插件，而不是自己下载安装包：
 * - **安装包必须验签**。否则任何人把伪造的包放到更新源上，全公司就都装上了。
 *   插件用编译进 App 的 minisign 公钥在 Rust 侧校验，前端既拿不到也改不了这个公钥。
 * - Windows 的静默安装、macOS 的替换 .app 并重启，各平台细节不同，插件已经处理好。
 * - 下载走 Rust reqwest，不受 WebView 的 CORS 限制。
 *
 * 版本清单（latest.json）的地址写在 src-tauri/tauri.conf.json 的
 * plugins.updater.endpoints 里，不放在这里 —— 编译期固定，避免运行时被改。
 *
 * 静默原则：所有失败都只在界面上留一行提示，绝不用弹窗打断填报。
 */

const CHECK_DELAY_MS = 3000;              // 启动后延迟检查：别和首屏数据抢带宽
const SNOOZE_KEY = 'qn_update_snooze';    // 「稍后」记忆：同版本静默 12 小时
const SNOOZE_MS = 12 * 60 * 60 * 1000;
const AUTO_HIDE_MS = 3000;

let busy = false;

function isTauri() {
  return typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ============ 提示条 ============ */

function bar() { return document.getElementById('update-bar'); }

function showBar(inner, kind = '') {
  const el = bar();
  if (!el) return null;
  el.className = `upd-bar${kind ? ' ' + kind : ''}`;
  el.innerHTML = inner;
  el.hidden = false;
  return el;
}

function hideBar() {
  const el = bar();
  if (!el) return;
  el.hidden = true;
  el.innerHTML = '';
}

let autoHideTimer = null;
function scheduleAutoHide() {
  clearTimeout(autoHideTimer);
  autoHideTimer = setTimeout(hideBar, AUTO_HIDE_MS);
}

/* ============ 「稍后」记忆 ============ */

function snoozed(version) {
  try {
    const raw = JSON.parse(localStorage.getItem(SNOOZE_KEY) || 'null');
    return !!raw && raw.version === version && Date.now() - raw.at < SNOOZE_MS;
  } catch { return false; }
}

function snooze(version) {
  try { localStorage.setItem(SNOOZE_KEY, JSON.stringify({ version, at: Date.now() })); } catch { /* ignore */ }
}

/* ============ 插件懒加载 ============ */

let _plugins = null;
async function loadPlugins() {
  if (!_plugins) {
    const [upd, proc] = await Promise.all([
      import('@tauri-apps/plugin-updater'),
      import('@tauri-apps/plugin-process'),
    ]);
    _plugins = { check: upd.check, relaunch: proc.relaunch };
  }
  return _plugins;
}

/* ============ 检查更新 ============ */

/**
 * @param {boolean} manual 手动触发（底部版本号点击）——
 *        手动时即使「已是最新」或失败也要给出反馈，自动检查则完全静默。
 */
async function checkForUpdate(manual = false) {
  if (busy) return;
  busy = true;
  if (manual) showBar('<span class="upd-text">正在检查更新…</span>');

  try {
    const { check } = await loadPlugins();
    const update = await check();

    if (!update) {
      if (manual) {
        const ver = await currentVersion();
        showBar(`<span class="upd-text ok">已是最新版本${ver ? ' v' + esc(ver) : ''}</span>`, 'ok');
        scheduleAutoHide();
      }
      busy = false;
      return;
    }

    // 自动检查时若用户刚点过「稍后」，这一轮就不打扰
    if (!manual && snoozed(update.version)) { closeUpdate(update); busy = false; return; }

    renderAvailable(update, manual);
  } catch (e) {
    // 自动检查失败一律静默：断网、公司网络拦截、COS 临时不可用都不该打扰用户
    if (manual) {
      showBar(`<span class="upd-text err">检查更新失败：${esc(e.message || e)}</span>
        <span class="upd-actions"><button id="upd-retry" class="upd-btn primary">重试</button>
        <button id="upd-close" class="upd-btn">关闭</button></span>`, 'err');
      document.getElementById('upd-retry').addEventListener('click', () => checkForUpdate(true));
      document.getElementById('upd-close').addEventListener('click', hideBar);
    }
  } finally {
    busy = false;
  }
}

function renderAvailable(update, manual) {
  const notes = update.body ? String(update.body).split('\n')[0].slice(0, 60) : '';
  showBar(`
    <span class="upd-text" title="${esc(update.body || '')}">
      发现新版本 <b>v${esc(update.version)}</b>${notes ? ' · ' + esc(notes) : ''}
    </span>
    <span class="upd-actions">
      <button id="upd-go" class="upd-btn primary">立即更新</button>
      <button id="upd-later" class="upd-btn">${manual ? '关闭' : '稍后'}</button>
    </span>`);

  document.getElementById('upd-go').addEventListener('click', () => startInstall(update));
  document.getElementById('upd-later').addEventListener('click', () => {
    if (!manual) snooze(update.version);
    closeUpdate(update);   // Update 是 Rust 侧资源，不用了就释放，避免反复检查累积
    hideBar();
  });
}

/** 释放 Rust 侧的 Update 资源（失败无所谓，只是标记一下） */
function closeUpdate(update) {
  try { if (update && typeof update.close === 'function') update.close(); } catch { /* ignore */ }
}

/* ============ 下载并安装 ============ */

async function startInstall(update) {
  if (busy) return;
  busy = true;

  let received = 0;
  let total = 0;

  const paint = () => {
    const pct = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : null;
    showBar(`
      <span class="upd-text">正在下载更新…${pct == null ? '' : ` <b>${pct}%</b>`}
        <span class="upd-bytes">${fmtMb(received)}${total > 0 ? ' / ' + fmtMb(total) : ''}</span>
      </span>
      <span class="upd-progress"><i style="width:${pct == null ? 8 : pct}%"></i></span>`);
  };

  paint();

  try {
    await update.downloadAndInstall(ev => {
      if (ev.event === 'Started') {
        total = ev.data?.contentLength || 0;
        paint();
      } else if (ev.event === 'Progress') {
        received += ev.data?.chunkLength || 0;
        paint();
      } else if (ev.event === 'Finished') {
        showBar('<span class="upd-text">下载完成，正在安装…</span>');
      }
    });

    // Windows：NSIS 安装器带 /R，装完会自己拉起新版本（这里的代码通常执行不到）。
    // macOS：必须由应用自己重启，否则内存里跑的还是旧版本。
    if (!/Windows/i.test(navigator.userAgent)) {
      showBar('<span class="upd-text">安装完成，正在重启…</span>');
      const { relaunch } = await loadPlugins();
      await relaunch();
    } else {
      showBar('<span class="upd-text">正在安装，即将自动重启…</span>');
    }
  } catch (e) {
    showBar(`
      <span class="upd-text err">更新失败：${esc(e.message || e)}</span>
      <span class="upd-actions">
        <button id="upd-retry" class="upd-btn primary">重试</button>
        <button id="upd-close" class="upd-btn">关闭</button>
      </span>`, 'err');
    document.getElementById('upd-retry').addEventListener('click', () => startInstall(update));
    document.getElementById('upd-close').addEventListener('click', hideBar);
  } finally {
    busy = false;
  }
}

function fmtMb(bytes) {
  if (!bytes) return '0 MB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

/* ============ 当前版本号（底部显示 + 手动检查入口） ============ */

async function currentVersion() {
  try {
    const { getVersion } = await import('@tauri-apps/api/app');
    return await getVersion();
  } catch { return ''; }
}

async function bindVersionLabel() {
  const el = document.getElementById('app-version');
  if (!el) return;
  const ver = await currentVersion();
  if (!ver) { el.remove(); return; }
  el.textContent = `v${ver}`;
  el.title = '点击检查更新';
  el.addEventListener('click', () => checkForUpdate(true));
}

/* ============ 入口 ============ */

/** 在 main.js 启动流程里调用一次即可（非 Tauri 环境自动跳过） */
export function initUpdater() {
  if (!isTauri()) return;
  bindVersionLabel();
  // 延迟到首屏数据加载之后再检查，避免抢带宽
  setTimeout(() => { checkForUpdate(false); }, CHECK_DELAY_MS);
}
