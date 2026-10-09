/**
 * report.js — 项目填报界面（选项卡 2）
 *
 * 交互：选人 → 选日期 → 选项目 → 填任务 → 提交
 * 覆盖用户需求 5（制作人员每日任务），并预留 1-4 的入口。
 *
 * 设计原则：
 * - 不侵入原有便签逻辑，独立渲染到 #report-panel
 * - 选人/选日期状态持久化到 localStorage，减少每天重复选择
 * - 项目搜索用本地过滤，91 条数据无需请求
 * - **项目必选**（v1.5.3）：任务内容可留空，但必须挂到一个项目上 ——
 *   否则记录会落到「（未指定）」，导出的「项目汇总」sheet 无法归类到项目。
 *   云端 `task_entries_project_required` CHECK 约束做第二道防线。
 */

import {
  fetchStaff, fetchProjects, fetchTasksByDate, addTask, deleteTask, updateTaskHours,
  fetchFollowups, addFollowup, fetchReviews, addReview, verifyAdminPassword, fetchCustomers,
  fetchProjectTasks, warmCache, peekCache,
  isExemptRole,
} from './cloud.js';
import { renderAdminView, markAdminUnlocked } from './admin.js';
import { beginView, staleView } from './view-guard.js';

const LS_USER = 'report_user';
const LS_VIEW = 'report_view';
// 特殊身份「管理员」：不对应具体人员，只用于进入管理后台。
// 不能用真名（真名都在 staff 表里），也不参与任何填报提交。
const ADMIN_USER = '管理员';

let staff = [];
let projects = [];
let currentUser = '';
let currentDate = '';
let currentView = 'task';   // task | followup | review | manage | admin
let tasksOfDay = [];
let booted = false;
let projectsListenerBound = false;

/* ============ 工具 ============ */

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(msg, kind = 'ok') {
  const el = document.getElementById('report-toast');
  if (!el) return;
  el.textContent = msg;
  el.className = `report-toast show ${kind}`;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.className = 'report-toast'; }, 2600);
}

function loadPref(k, dflt) {
  try { return localStorage.getItem(k) || dflt; } catch { return dflt; }
}
function savePref(k, v) {
  try { localStorage.setItem(k, v); } catch { /* ignore */ }
}

/* ============ 身份 ↔ tab 显隐 ============ */

function isAdminIdentity() { return currentUser === ADMIN_USER; }

/** 按身份显隐顶部 tab：
 *  普通身份 → 四个填报 tab，「管理」隐藏；
 *  管理员   → 整条外层 tab 隐藏（管理页自带一层子页 tab，不需要两层），
 *             也不产生填报记录；管理员要的项目维护在管理中枢里。 */
function applyRoleTabs() {
  const admin = isAdminIdentity();
  const bar = document.querySelector('.rp-tabs');
  if (bar) bar.style.display = admin ? 'none' : '';
  // 普通身份：四个填报 / 浏览 tab 可见，「管理」入口隐藏
  ['task', 'followup', 'review', 'manage'].forEach(v => {
    const btn = document.querySelector(`.rp-tab[data-view="${v}"]`);
    if (btn) btn.style.display = admin ? 'none' : '';
  });
  const adminTab = document.querySelector('.rp-tab[data-view="admin"]');
  if (adminTab) adminTab.style.display = 'none';
}

/** 身份与视图不匹配时归位（如上次停留的 tab 在切换身份后已不可见） */
function normalizeView() {
  if (isAdminIdentity()) {
    if (['task', 'followup', 'review'].includes(currentView)) currentView = 'admin';
  } else if (currentView === 'admin') {
    currentView = 'task';
  }
  savePref(LS_VIEW, currentView);
}

/** 让 tab 高亮与 currentView 保持一致（切换身份后视图可能被归位） */
function syncTabActive() {
  document.querySelectorAll('.rp-tab[data-view]').forEach(b =>
    b.classList.toggle('active', b.dataset.view === currentView));
}

/* ============ 渲染骨架 ============ */

export function mountReport() {
  const host = document.getElementById('report-panel');
  if (!host) return;
  host.innerHTML = `
    <div class="rp-bar">
      <div id="rp-user-slot" class="rp-user-slot"></div>
      <input type="date" id="rp-date" class="rp-date" title="选择日期" />
    </div>
    <div class="rp-tabs">
      <button data-view="task"     class="rp-tab active">每日任务</button>
      <button data-view="followup" class="rp-tab">客户跟进</button>
      <button data-view="review"   class="rp-tab">完工回访</button>
      <button data-view="manage"   class="rp-tab">项目清单</button>
      <button data-view="admin"    class="rp-tab admin">管理</button>
    </div>
    <div id="rp-body" class="rp-body"></div>
    <div id="report-toast" class="report-toast"></div>
  `;

  currentUser = loadPref(LS_USER, '');
  currentView = loadPref(LS_VIEW, 'task');
  // 旧版本残留的 history 视图已并入「管理」中枢
  if (currentView === 'history') currentView = 'admin';
  if (!['task', 'followup', 'review', 'manage', 'admin'].includes(currentView)) {
    currentView = 'task';
  }
  normalizeView();   // 上次可能是管理员身份停留的「管理」，或反之 —— 先按当前身份归位
  currentDate = today();

  host.querySelector('#rp-date').value = currentDate;
  host.querySelector('#rp-date').addEventListener('change', e => {
    currentDate = e.target.value || today();
    renderBody();
  });

  host.querySelectorAll('.rp-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      currentView = btn.dataset.view;
      savePref(LS_VIEW, currentView);
      host.querySelectorAll('.rp-tab').forEach(b =>
        b.classList.toggle('active', b === btn));
      renderBody();
    });
  });

  // 选人控件由 renderUserSlot() 动态渲染（锁定/解锁两种形态），事件在渲染时绑定

  // 恢复到上次的 tab（显隐已按身份调整，隐藏的 tab 点不到）
  syncTabActive();
  applyRoleTabs();

  // 管理中枢新增项目后刷新本地缓存（员工选项目picker保持最新）
  if (!projectsListenerBound) {
    projectsListenerBound = true;
    window.addEventListener('qn:projects-changed', async () => {
      try { projects = (await fetchProjects()) || []; } catch { /* 忽略，下次再刷 */ }
    });
    // 管理员增改人员后刷新员工端名单与身份锁显示
    window.addEventListener('qn:staff-changed', async () => {
      try {
        staff = (await fetchStaff()) || [];
        renderUserSlot();
      } catch { /* 忽略，下次再刷 */ }
    });
  }

  loadData();
}

async function loadData() {
  const body = document.getElementById('rp-body');
  // 冷启动时本地缓存已有上次的数据（cloud.js 的离线兜底）→ 先渲染，别让用户等网络
  const cachedStaff = peekCache('staff:active');
  const cachedProjects = peekCache('projects:list');
  // ★ 空名单**不算缓存**：它可能来自「未登录时读过一次」——服务端 RLS 会把匿名请求
  //   过滤成 0 行（200 空数组），并不是真的没有人员。若拿它先渲染，选人下拉里就只剩
  //   「管理员」，而且因为走的是「先返回旧值」的捷径，后面也不会再刷新。
  const useCache = Array.isArray(cachedStaff) && cachedStaff.length > 0
    && Array.isArray(cachedProjects) && cachedProjects.length > 0;
  if (useCache) {
    staff = cachedStaff;
    projects = cachedProjects;
    renderUserSlot();
    booted = true;
    renderBody();
  } else {
    body.innerHTML = '<div class="rp-loading">正在连接数据池…</div>';
  }
  try {
    // 没走缓存（或缓存不可信）时必须 force：否则 cachedRead 会把空数组当旧值直接返回，
    // 这一次渲染就永远停在空名单上。
    const [s, p] = await Promise.all([fetchStaff(!useCache), fetchProjects(!useCache)]);
    const fresh = { staff: s || [], projects: p || [] };
    // 和刚才先渲染的缓存一致就不重绘 —— 否则会把用户这几百毫秒里刚敲的字清掉
    const changed = !booted
      || JSON.stringify(staff) !== JSON.stringify(fresh.staff)
      || JSON.stringify(projects) !== JSON.stringify(fresh.projects);
    staff = fresh.staff;
    projects = fresh.projects;
    booted = true;
    if (changed) { renderUserSlot(); renderBody(); }
    warmCache();     // 后台预热常用数据，让第一次切页也秒开
  } catch (e) {
    if (booted) { toast('数据刷新失败：' + e.message, 'err'); return; }  // 有缓存就继续用，不打断
    body.innerHTML = `<div class="rp-error">
      <p><b>连接失败</b></p>
      <p class="rp-err-msg">${esc(e.message)}</p>
      <button id="rp-retry" class="rp-btn">重试</button>
    </div>`;
    const btn = document.getElementById('rp-retry');
    if (btn) btn.addEventListener('click', loadData);
  }
}

function fillUserSelect() {
  const sel = document.getElementById('rp-user');
  if (!sel) return;
  const groups = {};
  // 免填人员（纯客户经理 / 管理员）不参与每日填报，不出现在选人列表
  // 复合角色如「客户经理/项目经理」（孔东海、林思宇）仍保留
  // 注意：fetchStaff() 返回值没有 active 字段（服务端已 .eq('active',true) 过滤），这里不能再判 s.active
  staff.filter(s => !isExemptRole(s.role)).forEach(s => {
    const k = s.dept || s.role || '其他';
    (groups[k] = groups[k] || []).push(s);
  });
  let html = '<option value="">— 我是谁 —</option>';
  // 「管理员」是独立身份入口（不依赖 staff 表），选中后需口令验证才进入
  html += `<optgroup label="管理"><option value="${ADMIN_USER}"${
    currentUser === ADMIN_USER ? ' selected' : ''}>${ADMIN_USER}（后台管理）</option></optgroup>`;
  Object.keys(groups).forEach(k => {
    html += `<optgroup label="${esc(k)}">`;
    groups[k].forEach(s => {
      const sel2 = s.name === currentUser ? ' selected' : '';
      html += `<option value="${esc(s.name)}"${sel2}>${esc(s.name)}</option>`;
    });
    html += '</optgroup>';
  });
  sel.innerHTML = html;
}

/* ============ 身份锁定 ============ */
// 选定身份后锁定；要切换必须输管理员口令。userUnlocked 是口令验证通过后的临时解锁。

let userUnlocked = false;

function renderUserSlot() {
  const slot = document.getElementById('rp-user-slot');
  if (!slot) return;
  const me = staff.find(s => s.name === currentUser);

  // 已锁定，但存储的身份不在在职名单里（被停用/删除）→ 自动解锁重选
  // 「管理员」是特殊身份、不在 staff 名单里，跳过这条检查
  if (currentUser && !isAdminIdentity() && !userUnlocked && staff.length > 0 && !me) {
    userUnlocked = true;
    toast('原身份已不在名单中，请重新选择', 'err');
  }

  if (!currentUser || userUnlocked) {
    // 已解锁待重选时提供「取消」出口：口令输了又不想换 → 原样退回锁定态，
    // 不能把下拉框一直挂在那儿（否则用户以为身份被解除了）
    const canCancel = !!currentUser;
    slot.innerHTML = `
      <select id="rp-user" class="rp-select" title="选择填写人"></select>
      ${canCancel
        ? '<span class="rp-user-hint">选定后锁定</span><button id="rp-user-cancel" class="rp-user-switch" title="不换了，保持原身份">取消</button>'
        : ''}`;
    fillUserSelect();
    const sel = document.getElementById('rp-user');
    sel.addEventListener('change', e => {
      const v = e.target.value;
      if (!v || v === currentUser) return;
      if (v === ADMIN_USER && !userUnlocked) {
        // 选管理员必须过口令：先把下拉复位，验证通过后才真正落定身份
        e.target.value = '';
        askAdminPassword(true);
        return;
      }
      currentUser = v;
      savePref(LS_USER, currentUser);
      userUnlocked = false;          // 选定即锁
      normalizeView();
      applyRoleTabs();
      syncTabActive();
      renderUserSlot();
      renderBody();
    });
    const cancelBtn = document.getElementById('rp-user-cancel');
    if (cancelBtn) {
      const cancel = () => {
        userUnlocked = false;        // 收回解锁态，恢复原身份
        renderUserSlot();
        toast('已取消，保持原身份');
      };
      cancelBtn.addEventListener('click', cancel);
      sel.addEventListener('keydown', e => { if (e.key === 'Escape') cancel(); });
    }
  } else {
    const role = me ? me.role : '';
    slot.innerHTML = `
      <span class="rp-user-chip" title="身份已锁定，切换需管理员口令">👤 ${esc(currentUser)}${role ? ` · ${esc(role)}` : ''}</span>
      <button id="rp-user-switch" class="rp-user-switch" title="切换人员需管理员口令">🔒 切换</button>`;
    // 注意包一层箭头函数：直接把 askAdminPassword 当回调会把 click 事件塞进 asAdmin 参数
    slot.querySelector('#rp-user-switch').addEventListener('click', () => askAdminPassword());
  }
}

function askAdminPassword(asAdmin = false) {
  const old = document.getElementById('rp-pwd-mask');
  if (old) old.remove();
  const box = document.createElement('div');
  box.id = 'rp-pwd-mask';
  box.className = 'rp-pj-editor';
  box.innerHTML = `
    <div class="rp-pj-editor-inner" style="max-width:20rem">
      <div class="rp-pj-editor-head">
        <b>${asAdmin ? '管理员身份验证' : '切换身份'}</b>
        <button id="rp-pwd-close" class="rp-icon-btn" title="关闭">✕</button>
      </div>
      <div class="rp-pj-editor-body">
        <label class="rp-fld"><span>管理员口令</span>
          <input id="rp-pwd-input" class="rp-input" type="password" placeholder="输入管理员口令" /></label>
        <div class="rp-hint">${asAdmin
          ? '选择「管理员」需验证口令，通过后进入管理后台。'
          : '切换人员需管理员验证，防止误选他人身份。'}</div>
      </div>
      <div class="rp-form-actions">
        <button id="rp-pwd-ok" class="rp-btn primary">${asAdmin ? '验证并进入' : '验证并解锁'}</button>
      </div>
    </div>`;
  document.body.appendChild(box);
  const close = () => box.remove();
  document.getElementById('rp-pwd-close').addEventListener('click', close);
  box.addEventListener('click', e => { if (e.target === box) close(); });

  const input = document.getElementById('rp-pwd-input');
  input.focus();
  const ok = document.getElementById('rp-pwd-ok');
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') ok.click();
    if (e.key === 'Escape') close();
  });
  ok.addEventListener('click', async () => {
    const pwd = input.value;
    if (!pwd) { toast('请输入口令', 'err'); return; }
    try {
      if (await verifyAdminPassword(pwd)) {
        close();
        if (asAdmin) {
          // 落定为管理员身份；管理 tab 的口令锁一并放行，避免连输两次
          markAdminUnlocked();
          currentUser = ADMIN_USER;
          savePref(LS_USER, currentUser);
          userUnlocked = false;
          normalizeView();
          applyRoleTabs();
          syncTabActive();
          renderUserSlot();
          renderBody();
          toast('已进入管理员身份');
        } else {
          userUnlocked = true;
          renderUserSlot();
          toast('已解锁，请选择新身份');
        }
      } else {
        toast('口令错误', 'err');
      }
    } catch (e) { toast('验证失败：' + e.message, 'err'); }
  });
}

/* ============ 视图分发 ============ */

async function renderBody() {
  if (!booted) return;
  if (!currentUser) {
    const body = document.getElementById('rp-body');
    body.innerHTML = `<div class="rp-empty">请先在上方选择你的名字 👆</div>`;
    return;
  }
  if (currentView === 'admin') return renderAdminView();
  if (currentView === 'task') return renderTaskView();
  if (currentView === 'followup') return renderFollowupView();
  if (currentView === 'review') return renderReviewView();
  if (currentView === 'manage') return renderManageView();
}

/* ---------- 需求 5：每日任务 ---------- */

async function renderTaskView() {
  const t = beginView();
  const body = document.getElementById('rp-body');
  body.innerHTML = '<div class="rp-loading">加载当日任务…</div>';
  try {
    // 只取自己的记录（服务端过滤）—— 员工端不展示同事的填报内容
    tasksOfDay = (await fetchTasksByDate(currentDate, currentUser)) || [];
  } catch (e) {
    if (staleView(t)) return;          // 已切到别的 tab → 别把错误页盖上去
    body.innerHTML = `<div class="rp-error">读取失败：${esc(e.message)}</div>`;
    return;
  }
  if (staleView(t)) return;            // 等待期间切走了 → 丢弃这次结果

  const mine = tasksOfDay;

  body.innerHTML = `
    <div class="rp-form">
      <div class="rp-pick-label">项目<span class="rp-req">必选</span></div>
      <input type="text" id="rp-proj-filter" class="rp-input" placeholder="搜索项目（编号/名称/客户）…" />
      <div id="rp-proj-list" class="rp-proj-list"></div>
      <div id="rp-proj-picked" class="rp-req-hint"></div>
      <div id="rp-task-pick"></div>
      <textarea id="rp-task-text" class="rp-textarea" rows="3"
        placeholder="今天在这个项目上做了什么…（内容可留空）"></textarea>
      <button id="rp-submit" class="rp-btn primary">${
        currentDate < today() ? '补填到' : '提交到'
      } ${esc(currentDate)}</button>
    </div>
    <div class="rp-list-head">
      我的当日任务 <span class="rp-count" id="rp-my-count">${mine.length}</span>
    </div>
    <div id="rp-my-tasks"></div>
  `;

  renderProjectPicker();
  renderTaskLists(mine);

  const filter = document.getElementById('rp-proj-filter');
  filter.addEventListener('input', () => renderProjOptions(filter.value));

  document.getElementById('rp-submit').addEventListener('click', submitTask);
  document.getElementById('rp-task-text').addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submitTask();
  });
}

let pickedProject = null;
let pickedTask = null;   // 选中的项目任务；null = 以整个项目提交

function renderProjectPicker() {
  pickedProject = null;
  pickedTask = null;
  renderProjOptions('');
  markProjPicked();
  const tp = document.getElementById('rp-task-pick');
  if (tp) tp.innerHTML = '';
}

/**
 * 选中项目后加载该项目的任务（有任务才显示选择区）。
 * 「整个项目」是默认项 —— 不选任务也可以直接以项目提交。
 */
async function renderTaskChips() {
  const host = document.getElementById('rp-task-pick');
  if (!host) return;
  const code = pickedProject && pickedProject.code;
  if (!code) { host.innerHTML = ''; return; }

  let list = [];
  try { list = (await fetchProjectTasks(code)) || []; }
  catch { list = []; }
  // 加载期间用户又换了项目 → 丢弃这次结果
  if (!pickedProject || pickedProject.code !== code) return;
  if (!list.length) { host.innerHTML = ''; return; }

  host.innerHTML = `
    <div class="rp-pick-label">任务<span class="rp-opt">可选</span></div>
    <div class="rp-task-chips">
      <span class="rp-task-chip on" data-tkid="">整个项目</span>
      ${list.map(t => `<span class="rp-task-chip" data-tkid="${t.id}"
        data-tkname="${esc(t.name)}">${esc(t.name)}</span>`).join('')}
    </div>`;

  host.querySelectorAll('.rp-task-chip').forEach(c =>
    c.addEventListener('click', () => {
      const id = c.dataset.tkid;
      pickedTask = id ? { id: Number(id), name: c.dataset.tkname } : null;
      host.querySelectorAll('.rp-task-chip').forEach(x =>
        x.classList.toggle('on', x === c));
    }));
}

/** 刷新「已选项目」提示：未选 → 提示必选；已选 → 显示所选项目 */
function markProjPicked() {
  const el = document.getElementById('rp-proj-picked');
  if (!el) return;
  if (pickedProject) {
    el.className = 'rp-req-hint ok';
    el.textContent = '已选项目：' + [pickedProject.code, pickedProject.name]
      .filter(Boolean).join(' · ');
  } else {
    el.className = 'rp-req-hint';
    el.textContent = '还没有选择项目 —— 请在上方列表点选一个';
  }
}

function renderProjOptions(kw) {
  const list = document.getElementById('rp-proj-list');
  if (!list) return;
  const k = (kw || '').trim().toLowerCase();
  const matched = (k
    ? projects.filter(p =>
        (p.name || '').toLowerCase().includes(k) ||
        (p.code || '').toLowerCase().includes(k) ||
        (p.customer || '').toLowerCase().includes(k))
    : projects
  ).slice(0, 60);

  if (!projects.length) {
    list.innerHTML = '<div class="rp-hint">项目清单是空的 —— 请联系管理员在「项目管理」里添加项目</div>';
    return;
  }
  if (!matched.length) {
    list.innerHTML = '<div class="rp-hint">没有匹配的项目，换个关键词试试</div>';
    return;
  }
  list.innerHTML = matched.map(p => `
    <div class="rp-proj-item${pickedProject && pickedProject.id === p.id ? ' picked' : ''}"
         data-id="${p.id}">
      <span class="rp-proj-code">${esc(p.code || '')}</span>
      <span class="rp-proj-name">${esc(p.name || '')}</span>
      <span class="rp-proj-meta">${esc(p.customer || '')}${
        p.stage === 'presale' ? ' · 售前' : ''}</span>
    </div>`).join('');

  list.querySelectorAll('.rp-proj-item').forEach(el => {
    el.addEventListener('click', async () => {
      const id = Number(el.dataset.id);
      pickedProject = projects.find(p => p.id === id) || null;
      pickedTask = null;          // 换项目 → 清掉上一个项目选中的任务
      list.querySelectorAll('.rp-proj-item').forEach(x =>
        x.classList.toggle('picked', x === el));
      markProjPicked();
      await renderTaskChips();
    });
  });
}

/* ---------- 局部更新工具 ----------
 * 提交/删除/改工时一律就地改 DOM，不重绘整个视图 ——
 * 重绘会把填报区清空成 loading、滚动回顶、选中的项目和输入内容全丢，
 * 用户感知就是「填一条就刷一次全屏」。 */

/** 列表计数 +delta；计数元素不存在时静默跳过 */
function bumpCount(id, delta) {
  const el = document.getElementById(id);
  if (!el) return;
  const n = Math.max(0, (parseInt(el.textContent, 10) || 0) + delta);
  el.textContent = String(n);
}

/** 往列表容器插入一行 HTML，自动清掉「暂无记录」占位；返回插入的节点 */
function insertRow(listEl, html, where = 'afterbegin') {
  if (!listEl) return null;
  const ph = listEl.querySelector('.rp-empty');
  if (ph) ph.remove();
  listEl.insertAdjacentHTML(where, html);
  return where === 'afterbegin' ? listEl.firstElementChild : listEl.lastElementChild;
}

/** 给新插入的行加一次高亮脉冲，告诉用户「记到这儿了」 */
function flashRow(el) {
  if (!el) return;
  el.classList.add('rp-new');
  setTimeout(() => el.classList.remove('rp-new'), 1700);
}

/** 给「我的任务」列表内的行绑定删除 / 工时 chip（支持事后增量插入的单行） */
function bindMineRowEvents(scope) {
  scope.querySelectorAll('[data-del]').forEach(b =>
    b.addEventListener('click', async () => {
      const row = b.closest('.rp-task-row');
      const id = Number(b.dataset.del);
      b.disabled = true;
      try {
        await deleteTask(id);
        // 本行若展开着工时编辑条，一并收掉再移除行
        const nxt = row.nextElementSibling;
        if (nxt && nxt.classList.contains('rp-hours-editor')) nxt.remove();
        row.remove();
        bumpCount('rp-my-count', -1);
        tasksOfDay = tasksOfDay.filter(t => t.id !== id);
        const listEl = document.getElementById('rp-my-tasks');
        if (listEl && !listEl.querySelector('.rp-task-row')) {
          listEl.innerHTML = '<div class="rp-empty small">今天还没有记录</div>';
        }
        toast('已删除');
      } catch (e) {
        b.disabled = false;
        toast(e.message, 'err');
      }
    }));
  // 工时 chip → 展开/收起行内编辑条（两段式：早上填内容，下班填工时）
  scope.querySelectorAll('[data-hours]').forEach(chip =>
    chip.addEventListener('click', () => toggleHoursEditor(chip)));
}

/** 就地刷新工时 chip 的显示 */
function applyHoursChip(chip, hours) {
  chip.dataset.cur = hours == null ? '' : String(hours);
  chip.classList.toggle('empty', hours == null);
  chip.textContent = `⏱ ${hours == null ? '填工时' : `${Number(hours)}h`}`;
  chip.title = hours == null ? '下班后填实际工时' : '点击修改工时';
  const t = tasksOfDay.find(x => x.id === Number(chip.dataset.hours));
  if (t) t.hours = hours;
}

function renderTaskLists(mine) {
  const mineEl = document.getElementById('rp-my-tasks');
  if (mineEl) {
    mineEl.innerHTML = mine.length
      ? mine.map(t => taskRow(t, true)).join('')
      : '<div class="rp-empty small">今天还没有记录</div>';
    bindMineRowEvents(mineEl);
  }
}

/** 点工时 chip：在该行下方展开输入条；再点收起 */
function toggleHoursEditor(chip) {
  const row = chip.closest('.rp-task-row');
  const taskId = Number(chip.dataset.hours);
  const old = row.parentElement.querySelector('.rp-hours-editor');
  if (old) old.remove();               // 收起已有的（无论在哪行）
  if (old && old.dataset.for === String(taskId)) return; // 再点同一行 = 收起

  const cur = chip.dataset.cur || '';
  const editor = document.createElement('div');
  editor.className = 'rp-hours-editor';
  editor.dataset.for = taskId;
  editor.innerHTML = `
    <span class="rp-he-label">⏱ 实际工时</span>
    <input type="number" class="rp-input rp-he-input" min="0" max="24" step="0.5"
      value="${esc(cur)}" placeholder="如 6.5" />
    <span class="rp-he-unit">小时</span>
    <button class="rp-btn primary rp-he-save">保存</button>
    <button class="rp-btn rp-he-clear">清除</button>
    <button class="rp-btn rp-he-cancel">取消</button>`;
  row.insertAdjacentElement('afterend', editor);

  const input = editor.querySelector('.rp-he-input');
  input.focus();
  if (cur) input.select();

  const close = () => editor.remove();
  editor.querySelector('.rp-he-cancel').addEventListener('click', close);

  editor.querySelector('.rp-he-clear').addEventListener('click', async () => {
    try {
      await updateTaskHours(taskId, null);
      applyHoursChip(chip, null);
      editor.remove();
      toast('已清除工时');
    } catch (e) { toast('清除失败：' + e.message, 'err'); }
  });

  editor.querySelector('.rp-he-save').addEventListener('click', async () => {
    const v = parseFloat(input.value);
    if (isNaN(v) || v <= 0 || v > 24) {
      toast('请填 0 ~ 24 之间的小时数', 'err');
      return;
    }
    try {
      const val = Math.round(v * 100) / 100;
      await updateTaskHours(taskId, val);
      applyHoursChip(chip, val);
      editor.remove();
      toast('工时已记录 ✓');
    } catch (e) { toast('保存失败：' + e.message, 'err'); }
  });

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') editor.querySelector('.rp-he-save').click();
    if (e.key === 'Escape') close();
  });
}

function taskRow(t, own) {
  const proj = t.project_code
    ? `<span class="rp-tag">${esc(t.project_code)}</span>` : '';
  const tkTag = t.task_name ? `<span class="rp-tag tk">${esc(t.task_name)}</span>` : '';
  const hoursChip = own
    ? `<button class="rp-hours-chip${t.hours == null ? ' empty' : ''}"
         data-hours="${t.id}" data-cur="${t.hours ?? ''}"
         title="${t.hours == null ? '下班后填实际工时' : '点击修改工时'}">
         ⏱ ${t.hours == null ? '填工时' : `${Number(t.hours)}h`}</button>`
    : '';
  return `<div class="rp-task-row${own ? '' : ' muted'}">
    <div class="rp-task-main">
      <div class="rp-task-head">
        ${own ? '' : `<span class="rp-who">${esc(t.user_name)}</span>`}
        ${proj}
        ${tkTag}
      </div>
      <div class="rp-task-text">${esc(t.task_text || '（未填内容）')}</div>
      ${t.project_name ? `<div class="rp-task-proj">${esc(t.project_name)}</div>` : ''}
    </div>
    <div class="rp-task-side">
      ${hoursChip}
      ${own ? `<button class="rp-del" data-del="${t.id}" title="删除">✕</button>` : ''}
    </div>
  </div>`;
}

/** 提交成功后就地复位表单：清空输入与选择，但不动整个视图（保留滚动位置与筛选词） */
function resetTaskForm() {
  const ta = document.getElementById('rp-task-text');
  if (ta) ta.value = '';
  pickedProject = null;
  pickedTask = null;
  const filter = document.getElementById('rp-proj-filter');
  renderProjOptions(filter ? filter.value : '');   // 重建项目列表 → 顺带清掉选中高亮
  markProjPicked();
  const pick = document.getElementById('rp-task-pick');
  if (pick) pick.innerHTML = '';                   // 收起任务标签带
  const btn = document.getElementById('rp-submit');
  if (btn) {
    btn.disabled = false;
    btn.textContent = `${currentDate < today() ? '补填到' : '提交到'} ${currentDate}`;
  }
  if (ta) ta.focus({ preventScroll: true });   // 不把视图拽回表单，方便看刚提交的那条
}

async function submitTask() {
  const ta = document.getElementById('rp-task-text');
  const text = (ta.value || '').trim();
  // 项目必选 —— 否则记录会落到「（未指定）」，导出的「项目汇总」里无法归到项目
  if (!pickedProject) {
    toast('请先选择一个项目', 'err');
    const hint = document.getElementById('rp-proj-picked');
    if (hint) {
      hint.classList.add('warn');
      setTimeout(() => hint.classList.remove('warn'), 1200);
    }
    return;
  }
  const btn = document.getElementById('rp-submit');
  btn.disabled = true;
  btn.textContent = '提交中…';
  try {
    const saved = await addTask({
      entry_date: currentDate,
      user_name: currentUser,
      project_code: pickedProject.code,
      project_name: pickedProject.name,
      task_id: pickedTask ? pickedTask.id : null,
      task_name: pickedTask ? pickedTask.name : null,
      task_text: text || '（仅标记参与，无具体描述）',
    });
    toast('已提交 ✓');
    const row = Array.isArray(saved) ? saved[0] : saved;
    const listEl = document.getElementById('rp-my-tasks');
    if (row && row.id && listEl) {
      // 就地追加到「我的当日任务」，不重绘
      const el = insertRow(listEl, taskRow(row, true), 'beforeend');
      if (el) { bindMineRowEvents(el); flashRow(el); }
      bumpCount('rp-my-count', 1);
      tasksOfDay.push(row);
      resetTaskForm();
    } else {
      // 服务端没回写整行（异常路径）→ 兜底重载，避免界面上看不到刚提交的记录
      renderTaskView();
    }
  } catch (e) {
    toast('提交失败：' + e.message, 'err');
    btn.disabled = false;
    btn.textContent = `${currentDate < today() ? '补填到' : '提交到'} ${currentDate}`;
  }
}

/* ---------- 需求 3：客户跟进 ---------- */

async function renderFollowupView() {
  const t = beginView();
  const body = document.getElementById('rp-body');
  // 两个请求并行发出（原先串行，等于白等一个往返）
  const cached = Array.isArray(peekCache(`followups:${currentUser || '*'}:60`));
  if (!cached) body.innerHTML = '<div class="rp-loading">加载客户跟进…</div>';
  let rows = [];
  let customers = [];
  try {
    [rows, customers] = await Promise.all([
      fetchFollowups(60, currentUser).then(r => r || []),
      fetchCustomers().then(c => c || []),
    ]);
  } catch (e) {
    if (staleView(t)) return;
    body.innerHTML = `<div class="rp-error">读取失败：${esc(e.message)}</div>`;
    return;
  }
  if (staleView(t)) return;            // 等待期间切走了 → 丢弃这次结果

  body.innerHTML = `
    <div class="rp-form">
      <select id="rp-cust" class="rp-select wide">
        <option value="">选择客户…</option>
        ${customers.map(c => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('')}
      </select>
      <input type="text" id="rp-fu-contact" class="rp-input" placeholder="联系人（选客户后自动带出，可改）" />
      <textarea id="rp-fu-content" class="rp-textarea" rows="3"
        placeholder="本次跟进内容（沟通了什么、客户态度、下一步）…"></textarea>
      <input type="text" id="rp-fu-feedback" class="rp-input" placeholder="客户反馈（可选）" />
      <button id="rp-fu-submit" class="rp-btn primary">提交跟进记录</button>
    </div>
    <div class="rp-list-head">我的跟进记录 <span class="rp-count" id="rp-fu-count">${rows.length}</span></div>
    <div id="rp-fu-list">${rows.length ? rows.map(fuRow).join('') : '<div class="rp-empty small">暂无记录</div>'}</div>
  `;

  // 选客户后自动带出该客户的默认联系人；手动改过（值 ≠ 上次自动带出的值）就不再覆盖
  const custSel = document.getElementById('rp-cust');
  const contactInput = document.getElementById('rp-fu-contact');
  let lastAutoContact = '';
  if (custSel && contactInput) {
    custSel.addEventListener('change', () => {
      const c = customers.find(x => x.name === custSel.value);
      const def = (c && c.contact) || '';
      const cur = contactInput.value.trim();
      if (cur === '' || cur === lastAutoContact) {
        contactInput.value = def;
        lastAutoContact = def;
      }
    });
  }

  document.getElementById('rp-fu-submit').addEventListener('click', async () => {
    const content = document.getElementById('rp-fu-content').value.trim();
    if (!content) { toast('请填写跟进内容', 'err'); return; }
    const btn = document.getElementById('rp-fu-submit');
    btn.disabled = true;
    btn.textContent = '提交中…';
    try {
      const saved = await addFollowup({
        follow_date: currentDate,
        user_name: currentUser,
        customer: document.getElementById('rp-cust').value || null,
        content,
        feedback: document.getElementById('rp-fu-feedback').value.trim() || null,
        contact: document.getElementById('rp-fu-contact').value.trim() || null,
      });
      toast('已提交 ✓');
      const row = Array.isArray(saved) ? saved[0] : saved;
      if (row && row.id) {
        // 就地插到列表顶部，表单清空 —— 不重绘整个视图
        flashRow(insertRow(document.getElementById('rp-fu-list'), fuRow(row), 'afterbegin'));
        bumpCount('rp-fu-count', 1);
        document.getElementById('rp-cust').value = '';
        document.getElementById('rp-fu-contact').value = '';
        document.getElementById('rp-fu-content').value = '';
        document.getElementById('rp-fu-feedback').value = '';
      } else {
        renderFollowupView();
      }
      btn.disabled = false;
      btn.textContent = '提交跟进记录';
    } catch (e) {
      toast('提交失败：' + e.message, 'err');
      btn.disabled = false;
      btn.textContent = '提交跟进记录';
    }
  });
}

function fuRow(f) {
  return `<div class="rp-task-row">
    <div class="rp-task-main">
      <div class="rp-task-head">
        <span class="rp-tag">${esc(f.follow_date)}</span>
        ${f.customer ? `<span class="rp-tag alt">${esc(f.customer)}</span>` : ''}
        ${f.contact ? `<span class="rp-tag alt">👤 ${esc(f.contact)}</span>` : ''}
      </div>
      <div class="rp-task-text">${esc(f.content)}</div>
      ${f.feedback ? `<div class="rp-task-proj">反馈：${esc(f.feedback)}</div>` : ''}
    </div>
  </div>`;
}

/* ---------- 需求 4：完工回访 ---------- */

async function renderReviewView() {
  const t = beginView();
  const body = document.getElementById('rp-body');
  body.innerHTML = '<div class="rp-loading">加载完工回访…</div>';
  let rows = [];
  try { rows = (await fetchReviews(60, currentUser)) || []; }
  catch (e) {
    if (staleView(t)) return;
    body.innerHTML = `<div class="rp-error">读取失败：${esc(e.message)}</div>`;
    return;
  }
  if (staleView(t)) return;            // 等待期间切走了 → 丢弃这次结果

  // 已完工/已结算的排最前；其余按执行/售前分组兜底，保证下拉永远选得到项目
  const isDone = s => !!s && /完工|结算|已完/.test(s);
  const done = projects.filter(p => isDone(p.status));
  const exec = projects.filter(p => !isDone(p.status) && p.stage === 'exec');
  const pre  = projects.filter(p => !isDone(p.status) && p.stage !== 'exec');

  const revOpt = p => `<option value="${esc(p.code)}" data-name="${esc(p.name)}"
          data-cust="${esc(p.customer || '')}">${esc(p.code)} ${esc(p.name)}</option>`;
  const revGroups = [
    ['已完工 / 已结算', done],
    ['执行中', exec],
    ['售前', pre],
  ].filter(([, list]) => list.length)
   .map(([label, list]) =>
     `<optgroup label="${label}（${list.length}）">${list.map(revOpt).join('')}</optgroup>`)
   .join('');

  body.innerHTML = `
    <div class="rp-form">
      <select id="rp-rev-proj" class="rp-select wide">
        <option value="">选择项目…</option>
        ${revGroups}
      </select>
      ${done.length ? '' : `<div class="rp-note">还没有项目被标记为「完工 / 已结算」。
        项目陆续交付后，到「项目管理」把它的状态改成「完工」，它就会自动排到这份列表的最上方。</div>`}
      <div class="rp-score">
        <span>客户满意度</span>
        ${[1,2,3,4,5].map(n =>
          `<button class="rp-star" data-score="${n}">${n}</button>`).join('')}
      </div>
      <textarea id="rp-rev-content" class="rp-textarea" rows="3"
        placeholder="回访内容（客户评价、遗留问题、后续机会）…"></textarea>
      <button id="rp-rev-submit" class="rp-btn primary">提交回访</button>
    </div>
    <div class="rp-list-head">我的回访记录 <span class="rp-count" id="rp-rv-count">${rows.length}</span></div>
    <div id="rp-rv-list">${rows.length ? rows.map(revRow).join('') : '<div class="rp-empty small">暂无记录</div>'}</div>
  `;

  let score = null;
  body.querySelectorAll('.rp-star').forEach(b => {
    b.addEventListener('click', () => {
      score = Number(b.dataset.score);
      body.querySelectorAll('.rp-star').forEach(x =>
        x.classList.toggle('on', Number(x.dataset.score) <= score));
    });
  });

  document.getElementById('rp-rev-submit').addEventListener('click', async () => {
    const sel = document.getElementById('rp-rev-proj');
    const opt = sel.options[sel.selectedIndex];
    const content = document.getElementById('rp-rev-content').value.trim();
    if (!content) { toast('请填写回访内容', 'err'); return; }
    const btn = document.getElementById('rp-rev-submit');
    btn.disabled = true;
    btn.textContent = '提交中…';
    try {
      const saved = await addReview({
        review_date: currentDate,
        reviewer: currentUser,
        project_code: opt.value || null,
        project_name: opt.dataset.name || null,
        customer: opt.dataset.cust || null,
        score,
        content,
      });
      toast('已提交 ✓');
      const row = Array.isArray(saved) ? saved[0] : saved;
      if (row && row.id) {
        // 就地插到列表顶部，表单清空 —— 不重绘整个视图
        flashRow(insertRow(document.getElementById('rp-rv-list'), revRow(row), 'afterbegin'));
        bumpCount('rp-rv-count', 1);
        sel.value = '';
        document.getElementById('rp-rev-content').value = '';
        score = null;
        body.querySelectorAll('.rp-star').forEach(x => x.classList.remove('on'));
      } else {
        renderReviewView();
      }
      btn.disabled = false;
      btn.textContent = '提交回访';
    } catch (e) {
      toast('提交失败：' + e.message, 'err');
      btn.disabled = false;
      btn.textContent = '提交回访';
    }
  });
}

function revRow(r) {
  const stars = r.score ? '★'.repeat(r.score) : '';
  return `<div class="rp-task-row">
    <div class="rp-task-main">
      <div class="rp-task-head">
        <span class="rp-tag">${esc(r.review_date)}</span>
        ${r.project_code ? `<span class="rp-tag alt">${esc(r.project_code)}</span>` : ''}
        ${stars ? `<span class="rp-stars">${stars}</span>` : ''}
      </div>
      <div class="rp-task-text">${esc(r.content)}</div>
      ${r.project_name ? `<div class="rp-task-proj">${esc(r.project_name)}</div>` : ''}
    </div>
  </div>`;
}

/* ---------- 项目管理（全员浏览；新增项目在「管理」中枢里） ---------- */

async function renderManageView() {
  const body = document.getElementById('rp-body');
  const exec = projects.filter(p => p.stage === 'exec');
  const pre = projects.filter(p => p.stage === 'presale');

  body.innerHTML = `
    <div class="rp-hint" style="padding:2px 2px 8px">
      项目新增/编辑请到「管理」（需管理员口令）
    </div>
    <div class="rp-list-head">执行中 <span class="rp-count">${exec.length}</span></div>
    <div class="rp-mini">${exec.map(miniRow).join('')}</div>
    <div class="rp-list-head muted">售前 <span class="rp-count">${pre.length}</span></div>
    <div class="rp-mini">${pre.map(miniRow).join('')}</div>
  `;
}

function miniRow(p) {
  return `<div class="rp-mini-row">
    <span class="rp-proj-code">${esc(p.code || '')}</span>
    <span class="rp-proj-name">${esc(p.name || '')}</span>
    <span class="rp-proj-meta">${esc(p.project_mgr || '')}</span>
  </div>`;
}
