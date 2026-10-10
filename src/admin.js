/**
 * admin.js — 管理员中心（填报面板的「管理」选项卡，唯一管理员入口）
 *
 * 一个口令，五个子页：
 *   今日填报 —— 统计卡 + 按日期/人员/项目三种视角 + 未报提醒 + 导出 Excel
 *   历史填报 —— 全员填报原始记录（跨日期）
 *   项目管理 —— 新增/编辑项目 + 执行/售前列表 + 归档开关
 *   人员管理 —— 增人 / 改名 / 改职位 / 停用
 *   客户管理 —— 客户清单维护（供「客户跟进」的选择列表用）
 *
 * 导出 Excel 共 8 个 sheet：
 *   执行项目 / 售前项目 / 项目总览 / 填报明细 / 人员汇总 / 项目汇总
 *   / 客户跟进 / 完工回访
 * 末两个与「填报明细」同口径：都受汇总页「最近 N 天」范围的限制。
 *
 * 权限：整个选项卡需口令（SHA-256 哈希存云端 app_config）。
 *       这是"防误入"级别保护，不是强安全边界——真要严格权限得开登录。
 *
 * 与 report.js 的协作：
 * - 当前用户名从 localStorage('report_user') 读取（report.js 持久化的）
 * - 新增项目成功后派发 `qn:projects-changed` 事件，report.js 监听刷新项目缓存
 */

import {
  fetchStaffAll, fetchTasksInRange, verifyAdminPassword,
  fetchRecentTasks, fetchProjects, fetchProjectsFull, fetchProjectsAll,
  addProject, updateProject, deleteTask, addStaff, updateStaff,
  fetchCustomers, fetchCustomersAll, addCustomer, updateCustomer, deleteCustomer,
  fetchFollowupsInRange, fetchReviewsInRange,
  fetchAllProjectTasks, addProjectTask, updateProjectTask, deleteProjectTask,
  deleteStaff, deleteProject, deleteProjectTasksByCode,
  isExemptRole,
} from './cloud.js';
import { exportXlsx } from './export.js';
import { beginView, staleView } from './view-guard.js';
import { renderAnalytics } from './analytics.js';

const LS_ADMIN_OK = 'report_admin_ok';   // 本次会话是否已通过口令
const LS_ADMIN_SUB = 'report_admin_sub'; // 上次停留的子页

let rows = [];          // 汇总：当前日期范围内的填报记录
let staffAll = [];
let rangeDays = 0;      // 汇总范围（天）；0 = 全部。默认全部 —— 导出是给老板的台账，必须完整
let angle = 'byDate';   // 汇总：byDate | byPerson | byProject
let unsubmitted = [];   // 今天没报的人
let currentSub = 'summary';
let allProjects = [];   // 项目清单缓存（导出用）
let showArchived = false; // 项目维护：是否显示已归档项目

/* ── 汇总/导出的数据范围 ── */
const RANGE_ALL = 0;             // 范围下拉的「全部」档位
const DATE_MIN = '1970-01-01';   // 「全部」的下界（远早于任何真实数据）
const RANGE_OPTS = [
  [1, '最近 1 天'], [7, '最近 7 天'], [14, '最近 14 天'], [30, '最近 30 天'],
  [RANGE_ALL, '全部数据'],
];
/** 单次拉取上限。超出会在导出结果里提示，避免静默丢数据 */
const LIMIT_TASKS = 5000;
const LIMIT_SIDE = 5000;

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 当前范围的下界日期；「全部」返回 DATE_MIN */
function rangeStart() {
  return rangeDays === RANGE_ALL ? DATE_MIN : daysAgo(rangeDays - 1);
}

/** 范围文案，用于空状态与提示 */
function rangeLabel() {
  if (rangeDays === RANGE_ALL) return '全部';
  return `最近 ${rangeDays} 天`;
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

function loadPref(k, d) { try { return localStorage.getItem(k) || d; } catch { return d; } }
function savePref(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }

/* ============ 口令锁（共享组件） ============ */

/** 本次会话是否已通过管理员口令 */
export function isAdminUnlocked() {
  return loadPref(LS_ADMIN_OK, '0') === '1';
}

/** 标记已通过口令（report.js 验证管理员身份后调用，免得进管理 tab 再输一次） */
export function markAdminUnlocked() {
  savePref(LS_ADMIN_OK, '1');
}

/** 在 body 里渲染口令锁，解锁成功后回调 onUnlocked */
export function renderLockedGate(body, onUnlocked) {
  body.innerHTML = `
    <div class="rp-lock">
      <div class="rp-lock-icon">🔒</div>
      <div class="rp-lock-title">管理员视图</div>
      <div class="rp-lock-desc">这里的内容仅限管理员查看。<br/>请输入管理员口令。</div>
      <input type="password" id="rp-admin-pwd" class="rp-input" placeholder="管理员口令" />
      <button id="rp-admin-go" class="rp-btn primary">进入</button>
      <div id="rp-admin-msg" class="rp-lock-msg"></div>
    </div>
  `;
  const input = document.getElementById('rp-admin-pwd');
  const btn = document.getElementById('rp-admin-go');
  const msg = document.getElementById('rp-admin-msg');

  const attempt = async () => {
    const pwd = input.value;
    if (!pwd) { msg.textContent = '请输入口令'; return; }
    btn.disabled = true;
    btn.textContent = '校验中…';
    msg.textContent = '';
    try {
      const ok = await verifyAdminPassword(pwd);
      if (ok) {
        savePref(LS_ADMIN_OK, '1');
        onUnlocked();
      } else {
        msg.textContent = '口令不正确';
        btn.disabled = false;
        btn.textContent = '进入';
        input.select();
      }
    } catch (e) {
      msg.textContent = '校验失败：' + e.message;
      btn.disabled = false;
      btn.textContent = '进入';
    }
  };

  btn.addEventListener('click', attempt);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') attempt(); });
  input.focus();
}

/* ============ 入口：管理中枢 ============ */

export async function renderAdminView() {
  const body = document.getElementById('rp-body');

  if (!isAdminUnlocked()) {
    renderLockedGate(body, () => renderAdminView());
    return;
  }

  currentSub = loadPref(LS_ADMIN_SUB, 'summary');
  if (!['summary', 'analytics', 'history', 'projects', 'staff', 'customers'].includes(currentSub)) currentSub = 'summary';

  body.innerHTML = `
    <div class="rp-adm-hubbar">
      <div class="rp-tabs rp-adm-tabs">
        <button class="rp-tab" data-sub="summary">今日填报</button>
        <button class="rp-tab" data-sub="analytics">数据分析</button>
        <button class="rp-tab" data-sub="history">历史填报</button>
        <button class="rp-tab" data-sub="projects">项目管理</button>
        <button class="rp-tab" data-sub="staff">人员管理</button>
        <button class="rp-tab" data-sub="customers">客户管理</button>
      </div>
      <button id="rp-adm-exit" class="rp-chip">退出管理</button>
    </div>
    <div id="rp-adm-sub"></div>
  `;

  body.querySelectorAll('.rp-tab[data-sub]').forEach(b => {
    b.addEventListener('click', () => {
      currentSub = b.dataset.sub;
      savePref(LS_ADMIN_SUB, currentSub);
      setActiveSub();
      renderSub();
    });
  });

  document.getElementById('rp-adm-exit').addEventListener('click', () => {
    savePref(LS_ADMIN_OK, '0');
    renderLockedGate(body, () => renderAdminView());
  });

  setActiveSub();
  await renderSub();
}

function setActiveSub() {
  document.querySelectorAll('.rp-tab[data-sub]').forEach(b =>
    b.classList.toggle('active', b.dataset.sub === currentSub));
}

/**
 * 渲染管理子页。
 * @param {boolean} silent 操作后刷新用 true —— 不闪「加载中…」，旧内容保留到新内容就绪再替换，
 *                         并保持滚动位置。重绘整块子页（导航/切页）才用 false。
 */
async function renderSub(silent = false) {
  const host = document.getElementById('rp-adm-sub');
  if (!host) return;
  const t = beginView();               // 切子页后旧请求的结果一律作废
  const scroller = document.getElementById('rp-body');
  const keepTop = silent && scroller ? scroller.scrollTop : null;
  if (!silent) host.innerHTML = '<div class="rp-loading">加载中…</div>';
  try {
    if (currentSub === 'analytics') await renderAnalytics(host, t);
    else if (currentSub === 'history') await renderHistorySub(host, t);
    else if (currentSub === 'projects') await renderProjectsSub(host, t);
    else if (currentSub === 'staff') await renderStaffSub(host, t);
    else if (currentSub === 'customers') await renderCustomersSub(host, t);
    else await renderSummarySub(host, t);
  } catch (e) {
    if (staleView(t)) return;
    host.innerHTML = `<div class="rp-error">读取失败：${esc(e.message)}</div>`;
    return;
  }
  if (keepTop != null && scroller) scroller.scrollTop = keepTop;
}

/* ============ 子页 1：汇总 ============ */

async function loadAll() {
  const to = today();
  const from = rangeStart();
  const [s, t] = await Promise.all([
    fetchStaffAll(),
    fetchTasksInRange(from, to, LIMIT_TASKS),
  ]);
  staffAll = s || [];
  rows = t || [];

  // 今天谁没报（免填人员：纯客户经理 / 管理员，不计入未报提醒）
  const activeStaff = staffAll.filter(x => x.active && !isExemptRole(x.role));
  const todayReporters = new Set(
    rows.filter(r => String(r.entry_date).slice(0, 10) === to).map(r => r.user_name)
  );
  unsubmitted = activeStaff.filter(x => !todayReporters.has(x.name));
}

async function renderSummarySub(host, t) {
  await loadAll();

  const total = rows.length;
  const people = new Set(rows.map(r => r.user_name)).size;
  const projCount = new Set(rows.filter(r => r.project_code).map(r => r.project_code)).size;

  // 项目全字段（含金额）只在导出时用得上 → 不再在进页面时就拉，改到点「导出」时随其他数据并行取。
  if (staleView(t)) return;

  host.innerHTML = `
    <div class="rp-adm-stats">
      <div class="rp-stat"><b>${total}</b><span>条填报</span></div>
      <div class="rp-stat"><b>${people}</b><span>人参与</span></div>
      <div class="rp-stat"><b>${projCount}</b><span>个项目</span></div>
      <div class="rp-stat${unsubmitted.length ? ' warn' : ''}">
        <b>${unsubmitted.length}</b><span>今日未报</span>
      </div>
    </div>

    <div class="rp-adm-bar">
      <select id="rp-adm-range" class="rp-select" title="数据范围：同时决定页面统计和导出的条数">
        ${RANGE_OPTS.map(([v, label]) =>
          `<option value="${v}"${v === rangeDays ? ' selected' : ''}>${label}</option>`).join('')}
      </select>
      <button id="rp-adm-export" class="rp-btn primary">导出 Excel</button>
    </div>

    <div class="rp-angle">
      ${[['byDate', '按日期'], ['byPerson', '按人员'], ['byProject', '按项目']].map(([v, label]) =>
        `<button class="rp-tab${angle === v ? ' active' : ''}" data-angle="${v}">${label}</button>`).join('')}
    </div>

    <div id="rp-adm-unsub"></div>
    <div id="rp-adm-content"></div>
  `;

  // 未报提醒
  const unsubEl = document.getElementById('rp-adm-unsub');
  if (unsubmitted.length) {
    unsubEl.innerHTML = `
      <div class="rp-unsub">
        <div class="rp-unsub-head">今日未提交 <span class="rp-count">${unsubmitted.length}</span></div>
        <div class="rp-unsub-names">
          ${unsubmitted.map(s => `<span class="rp-unsub-chip">${esc(s.name)}</span>`).join('')}
        </div>
      </div>`;
  }

  document.getElementById('rp-adm-range').addEventListener('change', async e => {
    rangeDays = Number(e.target.value);
    await renderSub(true);
  });

  document.getElementById('rp-adm-export').addEventListener('click', doExport);

  host.querySelectorAll('.rp-tab[data-angle]').forEach(b => {
    b.addEventListener('click', () => {
      angle = b.dataset.angle;
      renderContent();
      host.querySelectorAll('.rp-tab[data-angle]').forEach(x =>
        x.classList.toggle('active', x === b));
    });
  });

  renderContent();
}

/* ---------- 汇总三种视角 ---------- */

/** 工时显示小标签：null → 空串 */
function hoursTag(h) {
  return h == null ? '' : `<span class="rp-tag hours" title="实际工时">⏱ ${Number(h)}h</span>`;
}
/** 一组记录的工时合计（未填的不计入，返回 null 表示全未填） */
function sumHours(list) {
  const s = list.reduce((acc, r) => acc + (r.hours == null ? 0 : Number(r.hours)), 0);
  return s > 0 ? Math.round(s * 100) / 100 : null;
}

function renderContent() {
  const el = document.getElementById('rp-adm-content');
  if (!el) return;
  if (!rows.length) {
    el.innerHTML = `<div class="rp-empty small">${rangeDays === RANGE_ALL ? '还没有任何填报记录' : '这段时间没有填报记录'}</div>`;
    return;
  }
  if (angle === 'byPerson') el.innerHTML = viewByPerson();
  else if (angle === 'byProject') el.innerHTML = viewByProject();
  else el.innerHTML = viewByDate();

  el.querySelectorAll('[data-del]').forEach(b =>
    b.addEventListener('click', async () => {
      if (!confirm('确定删除这条填报？')) return;
      try {
        await deleteTask(Number(b.dataset.del));
        toast('已删除');
        await renderSub(true);
      } catch (e) { toast(e.message, 'err'); }
    }));
}

/** 按日期：每天一节，列出所有人和内容 —— 最接近原来那张共享表格 */
function viewByDate() {
  const g = {};
  rows.forEach(r => {
    const d = String(r.entry_date).slice(0, 10);
    (g[d] = g[d] || []).push(r);
  });
  return Object.keys(g).sort().reverse().map(d => {
    const list = g[d];
    const who = new Set(list.map(r => r.user_name)).size;
    const hs = sumHours(list);
    return `
      <div class="rp-list-head">${esc(d)}
        <span class="rp-count">${list.length} 条 / ${who} 人${hs != null ? ` / ⏱ ${hs}h` : ''}</span>
      </div>
      ${list.map(r => `
        <div class="rp-task-row">
          <div class="rp-task-main">
            <div class="rp-task-head">
              <span class="rp-who">${esc(r.user_name)}</span>
              ${r.project_code ? `<span class="rp-tag">${esc(r.project_code)}</span>` : ''}
              ${hoursTag(r.hours)}
            </div>
            <div class="rp-task-text">${esc(r.task_text || '（未填内容）')}</div>
            ${r.project_name ? `<div class="rp-task-proj">${esc(r.project_name)}</div>` : ''}
          </div>
          <button class="rp-del" data-del="${r.id}" title="删除">✕</button>
        </div>`).join('')}
    `;
  }).join('');
}

/** 按人员：每人一节，看谁的记录最多/最少 */
function viewByPerson() {
  const g = {};
  rows.forEach(r => { (g[r.user_name] = g[r.user_name] || []).push(r); });
  return Object.keys(g).sort((a, b) => g[b].length - g[a].length).map(name => {
    const list = g[name];
    const days = new Set(list.map(r => String(r.entry_date).slice(0, 10))).size;
    const hs = sumHours(list);
    return `
      <div class="rp-list-head">${esc(name)}
        <span class="rp-count">${list.length} 条 / ${days} 天${hs != null ? ` / ⏱ ${hs}h` : ''}</span>
      </div>
      ${list.map(r => `
        <div class="rp-task-row">
          <div class="rp-task-main">
            <div class="rp-task-head">
              <span class="rp-tag alt">${esc(String(r.entry_date).slice(0, 10))}</span>
              ${r.project_code ? `<span class="rp-tag">${esc(r.project_code)}</span>` : ''}
              ${hoursTag(r.hours)}
            </div>
            <div class="rp-task-text">${esc(r.task_text || '（未填内容）')}</div>
            ${r.project_name ? `<div class="rp-task-proj">${esc(r.project_name)}</div>` : ''}
          </div>
          <button class="rp-del" data-del="${r.id}" title="删除">✕</button>
        </div>`).join('')}
    `;
  }).join('');
}

/** 按项目：每个项目一节，形成项目周报素材 */
function viewByProject() {
  const g = {};
  rows.forEach(r => {
    const k = r.project_code || '（未指定项目）';
    (g[k] = g[k] || []).push(r);
  });
  return Object.keys(g).sort().map(code => {
    const list = g[code];
    const who = [...new Set(list.map(r => r.user_name))];
    const pname = list.find(r => r.project_name)?.project_name || '';
    const hs = sumHours(list);
    return `
      <div class="rp-list-head">
        <span class="rp-tag">${esc(code)}</span>
        <span style="font-weight:400;color:var(--text-3);font-size:0.68rem">
          ${list.length} 条 / ${who.length} 人${hs != null ? ` / ⏱ ${hs}h` : ''}
        </span>
      </div>
      ${pname ? `<div class="rp-pj-name">${esc(pname)}</div>` : ''}
      ${list.map(r => `
        <div class="rp-task-row">
          <div class="rp-task-main">
            <div class="rp-task-head">
              <span class="rp-who">${esc(r.user_name)}</span>
              <span class="rp-tag alt">${esc(String(r.entry_date).slice(0, 10))}</span>
              ${hoursTag(r.hours)}
            </div>
            <div class="rp-task-text">${esc(r.task_text || '（未填内容）')}</div>
          </div>
          <button class="rp-del" data-del="${r.id}" title="删除">✕</button>
        </div>`).join('')}
    `;
  }).join('');
}

/* ============ 子页 2：历史 ============ */

async function renderHistorySub(host, t) {
  const rowsAll = (await fetchRecentTasks(300)) || [];
  if (staleView(t)) return;
  const shown = rowsAll;

  // 按日期倒序分组
  const groups = {};
  shown.forEach(t => {
    const d = String(t.entry_date || '').slice(0, 10);
    (groups[d] = groups[d] || []).push(t);
  });
  const dates = Object.keys(groups).sort().reverse();

  host.innerHTML = `
    <div class="rp-hist-bar">
      <span class="rp-hist-total">最近 ${shown.length} 条（全员）</span>
    </div>
    ${dates.length
      ? dates.map(d => `
        <div class="rp-list-head">${esc(d)} <span class="rp-count">${groups[d].length}</span></div>
        ${groups[d].map(t => histRow(t)).join('')}
      `).join('')
      : '<div class="rp-empty small">还没有任何记录</div>'}
  `;
}

function histRow(t) {
  const who = `<span class="rp-who">${esc(t.user_name)}</span>`;
  const proj = t.project_code ? `<span class="rp-tag">${esc(t.project_code)}</span>` : '';
  const tk = t.task_name ? `<span class="rp-tag tk">${esc(t.task_name)}</span>` : '';
  return `<div class="rp-task-row muted">
    <div class="rp-task-main">
      <div class="rp-task-head">${who}${proj}${tk}${hoursTag(t.hours)}</div>
      <div class="rp-task-text">${esc(t.task_text || '（未填内容）')}</div>
      ${t.project_name ? `<div class="rp-task-proj">${esc(t.project_name)}</div>` : ''}
    </div>
  </div>`;
}

/* ============ 子页 3：项目维护 ============ */

/* ============ 项目维护 ============ */

/** 表单字段定义：[key, 标签, 类型, 占位/说明] */
const PJ_FIELDS = [
  ['code', '项目编号', 'text', '如 P26091614'],
  ['name', '项目名称', 'text', ''],
  ['customer', '客户', 'text', ''],
  ['account_mgr', '客户经理', 'text', ''],
  ['project_mgr', '项目经理', 'text', ''],
  ['contact', '客户联系人', 'text', '多人用 / 分隔'],
  ['stage', '阶段', 'select', ''],
  ['status', '状态', 'text', '如 进行中 / 完工'],
  ['po_amount', 'PO金额', 'number', ''],
  ['tax_amount', '税金6%', 'number', ''],
  ['outsource_amount', '外包金额', 'number', ''],
  ['signed_amount', '签单额', 'number', ''],
  ['valid_amount', '有效签单额', 'number', ''],
  ['quote_deadline', '方案报价截止日', 'date', ''],
  ['budget_link', '预算表', 'text', '有 / 无 或链接'],
  ['gr_text', 'GR', 'text', ''],
  ['invoice_text', '发票', 'text', ''],
  ['note1', '备注1', 'text', ''],
  ['note2', '备注2', 'text', ''],
  ['note3', '备注3', 'text', ''],
  ['progress', '本周执行进度', 'text', ''],
];

/** 带候选词（datalist）的文本字段：可点选，也可自由输入。
 *  status 词表覆盖云端现有全部取值（售前/进行中/未开始/提前开工/暂停中/待定），
 *  并补上「完工 / 已结算」——完工回访的项目下拉靠它识别已交付项目。 */
const PJ_LIST_OPTS = {
  status: ['售前', '待定', '未开始', '提前开工', '进行中', '暂停中', '完工', '已结算'],
};

function pjFieldHtml(f, val, idPrefix) {
  const [key, label, type, ph] = f;
  const v = val === null || val === undefined ? '' : String(val);
  const id = `${idPrefix}-${key}`;
  if (type === 'select') {
    return `<label class="rp-fld"><span>${label}</span>
      <select id="${id}" class="rp-select">
        <option value="exec"${v === 'exec' ? ' selected' : ''}>执行中</option>
        <option value="presale"${v === 'presale' ? ' selected' : ''}>售前</option>
      </select></label>`;
  }
  const opts = PJ_LIST_OPTS[key];
  if (opts) {
    const listId = `rp-dl-${idPrefix}-${key}`;
    return `<label class="rp-fld"><span>${label}</span>
      <input type="text" id="${id}" class="rp-input" value="${esc(v)}" list="${listId}"
        autocomplete="off" ${ph ? `placeholder="${esc(ph)}"` : ''} />
      <datalist id="${listId}">${opts.map(o =>
        `<option value="${esc(o)}"></option>`).join('')}</datalist></label>`;
  }
  return `<label class="rp-fld"><span>${label}</span>
    <input type="${type}" id="${id}" class="rp-input" value="${esc(v)}"
      ${ph ? `placeholder="${esc(ph)}"` : ''} /></label>`;
}

function pjFormHtml(p, idPrefix) {
  return `<div class="rp-pj-grid">${PJ_FIELDS.map(f => pjFieldHtml(f, p ? p[f[0]] : '', idPrefix)).join('')}</div>`;
}

/** 从表单读值，组装成项目对象 */
function readPjForm(idPrefix) {
  const o = {};
  for (const [key, , type] of PJ_FIELDS) {
    const el = document.getElementById(`${idPrefix}-${key}`);
    if (!el) continue;
    const raw = el.value.trim();
    if (key === 'stage') { o[key] = raw; continue; }
    if (type === 'number') {
      // 空串存 null，避免 0 污染统计
      o[key] = raw === '' ? null : Number(raw);
    } else {
      o[key] = raw || null;
    }
  }
  return o;
}

async function renderProjectsSub(host, t) {
  // 两份数据互不依赖，并行取（原先串行 = 多等一个完整往返）
  // 项目：拉全字段且包含归档项 —— 「查看已归档」开关需要能在同一份数据里筛
  // 任务：一次拉全，按 project_code 分组。分组数组直接交给覆盖层增删改 ——
  //       同一次进子页期间重复打开覆盖层操作的是同一份数据，不会出现「加了关掉再打开又没了」
  const [allRaw, allTasksRaw] = await Promise.all([
    fetchProjectsAll(),                       // 项目失败要报错（页面无内容），不吞
    fetchAllProjectTasks().catch(() => null)  // 任务失败降级为空，页面照常可用
  ]);
  const all = allRaw || [];
  const allTasks = allTasksRaw || [];
  const active = all.filter(p => !p.archived);
  const archived = all.filter(p => p.archived);

  if (staleView(t)) return;
  const tkByCode = {};
  allTasks.forEach(t => {
    const k = t.project_code || '';
    (tkByCode[k] = tkByCode[k] || []).push(t);
  });
  const tasksOf = code => tkByCode[code] || (tkByCode[code] = []);

  const visible = showArchived ? all : active;
  const exec = visible.filter(p => p.stage === 'exec');
  const pre = visible.filter(p => p.stage === 'presale');

  host.innerHTML = `
    <div class="rp-form">
      <div class="rp-subhead">新增项目 <span class="rp-adm-badge">管理员</span></div>
      ${pjFormHtml(null, 'rp-np')}
      <div class="rp-form-actions">
        <button id="rp-np-submit" class="rp-btn primary">添加项目</button>
      </div>
    </div>

    <div class="rp-arch-bar">
      <div class="rp-list-head">执行中 <span class="rp-count">${exec.length}</span></div>
      <label class="rp-chip${showArchived ? ' on' : ''}" id="rp-arch-toggle">
        <span class="rp-chip-box">${showArchived ? '☑' : '☐'}</span>
        查看已归档${archived.length ? ` (${archived.length})` : ''}
      </label>
    </div>
    <div class="rp-mini">${exec.map(p => miniRow(p, (tkByCode[p.code] || []).length)).join('') || '<div class="rp-empty-mini">暂无</div>'}</div>
    <div class="rp-list-head muted">售前 <span class="rp-count">${pre.length}</span></div>
    <div class="rp-mini">${pre.map(p => miniRow(p, (tkByCode[p.code] || []).length)).join('') || '<div class="rp-empty-mini">暂无</div>'}</div>
  `;

  document.getElementById('rp-np-submit').addEventListener('click', async () => {
    const payload = readPjForm('rp-np');
    if (!payload.name) { toast('请填写项目名称', 'err'); return; }
    payload.sort_order = 999;
    try {
      await addProject(payload);
      toast('已添加 ✓');
      window.dispatchEvent(new CustomEvent('qn:projects-changed'));
      await renderSub(true);
    } catch (e) { toast('添加失败：' + e.message, 'err'); }
  });

  document.getElementById('rp-arch-toggle').addEventListener('click', async () => {
    showArchived = !showArchived;
    await renderSub(true);
  });

  // 点列表项 → 打开编辑面板
  host.querySelectorAll('.rp-mini-row[data-id]').forEach(row => {
    row.addEventListener('click', () => openPjEditor(row.dataset.id, all));
  });

  // 任务入口 → 打开任务管理覆盖层（stopPropagation：别同时把项目编辑层也开了）
  host.querySelectorAll('[data-tasks]').forEach(b =>
    b.addEventListener('click', e => {
      e.stopPropagation();
      const p = all.find(x => String(x.id) === String(b.dataset.tasks));
      if (p) openTaskEditor(p, tasksOf(p.code || ''));
    }));

  // 物理删除项目（与「归档」区分：归档可恢复，删除不可逆）
  host.querySelectorAll('[data-pj-del]').forEach(b =>
    b.addEventListener('click', async e => {
      e.stopPropagation();
      const p = all.find(x => String(x.id) === b.dataset.pjDel);
      if (!p) return;
      const n = (tkByCode[p.code] || []).length;
      const msg = [
        `彻底删除项目「${p.code || '无编号'} ${p.name || ''}」？`,
        `· 项目从清单移除${n ? `，其下 ${n} 个任务一并删除` : ''}`,
        `· 已提交的填报记录、客户跟进、回访保留（记录里存的是当时的编号和名称）`,
        `· 删除不可恢复 —— 只是完成或暂缓的项目，用「归档」更合适（可随时找回）`,
      ].join('\n');
      if (!confirm(msg)) return;
      try {
        if (p.code && n) await deleteProjectTasksByCode(p.code);
        await deleteProject(p.id);
        toast('已删除');
        window.dispatchEvent(new CustomEvent('qn:projects-changed'));
        await renderSub(true);
      } catch (err) { toast('删除失败：' + err.message, 'err'); }
    }));
}

/** 点列表项后用覆盖层打开编辑表单 */
function openPjEditor(id, projects) {
  const p = projects.find(x => String(x.id) === String(id));
  if (!p) return;
  const old = document.getElementById('rp-pj-editor');
  if (old) old.remove();

  const isArchived = !!p.archived;

  const box = document.createElement('div');
  box.id = 'rp-pj-editor';
  box.className = 'rp-pj-editor';
  box.innerHTML = `
    <div class="rp-pj-editor-inner">
      <div class="rp-pj-editor-head">
        <b>编辑项目</b>
        <span class="rp-proj-code">${esc(p.code || '')}</span>
        ${isArchived ? '<span class="rp-arch-tag">已归档</span>' : ''}
        <button id="rp-pje-close" class="rp-icon-btn" title="关闭">✕</button>
      </div>
      <div class="rp-pj-editor-body">${pjFormHtml(p, 'rp-pe')}</div>
      <div class="rp-form-actions">
        <button id="rp-pe-save" class="rp-btn primary">保存修改</button>
        ${isArchived
          ? '<button id="rp-pe-unarch" class="rp-btn" title="把项目恢复到正常列表">恢复项目</button>'
          : '<button id="rp-pe-del" class="rp-btn" title="将项目标记为归档（不会真正删除）">归档项目</button>'}
      </div>
    </div>`;
  document.body.appendChild(box);

  const close = () => box.remove();
  document.getElementById('rp-pje-close').addEventListener('click', close);
  box.addEventListener('click', e => { if (e.target === box) close(); });

  document.getElementById('rp-pe-save').addEventListener('click', async () => {
    const patch = readPjForm('rp-pe');
    if (!patch.name) { toast('项目名称不能为空', 'err'); return; }
    try {
      await updateProject(p.id, patch);
      toast('已保存 ✓');
      window.dispatchEvent(new CustomEvent('qn:projects-changed'));
      close();
      await renderSub(true);
    } catch (e) { toast('保存失败：' + e.message, 'err'); }
  });

  const delBtn = document.getElementById('rp-pe-del');
  if (delBtn) delBtn.addEventListener('click', async () => {
    if (!confirm(`确定归档「${p.name}」？\n归档后不再出现在列表和导出中，数据仍保留在云端。\n（勾选「查看已归档」可随时恢复）`)) return;
    try {
      await updateProject(p.id, { archived: true });
      toast('已归档，可在「查看已归档」中找回');
      window.dispatchEvent(new CustomEvent('qn:projects-changed'));
      close();
      await renderSub(true);
    } catch (e) { toast('归档失败：' + e.message, 'err'); }
  });

  const unarchBtn = document.getElementById('rp-pe-unarch');
  if (unarchBtn) unarchBtn.addEventListener('click', async () => {
    try {
      await updateProject(p.id, { archived: false });
      toast('已恢复到列表 ✓');
      window.dispatchEvent(new CustomEvent('qn:projects-changed'));
      close();
      await renderSub(true);
    } catch (e) { toast('恢复失败：' + e.message, 'err'); }
  });
}

/* ---------- 项目任务管理（v1.5.4） ---------- */

/**
 * 某个项目的任务管理覆盖层：列任务 / 加任务 / 改名（行内）/ 删除。
 * 任务挂在 project_code 上，与 task_entries、跟进、回访的口径保持一致。
 * @param {object} p 项目对象
 * @param {Array} tasks 该项目的任务数组（就地增删，覆盖层内复用）
 */
/** 就地刷新项目行上的任务计数徽章（加/删任务后调用；不重建子页 —— 重建会让页面闪一下） */
function refreshTaskBadge(projectId, count) {
  const btn = document.querySelector(`.rp-tk-btn[data-tasks="${projectId}"]`);
  if (!btn) return;
  btn.textContent = count ? `任务 ${count}` : '＋任务';
  btn.classList.toggle('has', count > 0);
}

function openTaskEditor(p, tasks) {
  const old = document.getElementById('rp-tk-editor');
  if (old) old.remove();

  const code = p.code || '';

  const box = document.createElement('div');
  box.id = 'rp-tk-editor';
  box.className = 'rp-pj-editor';
  box.innerHTML = `
    <div class="rp-pj-editor-inner" style="max-width:26rem">
      <div class="rp-pj-editor-head">
        <b>项目任务</b>
        <span class="rp-proj-code">${esc(code || '无编号')}</span>
        <button id="rp-tke-close" class="rp-icon-btn" title="关闭">✕</button>
      </div>
      <div class="rp-tk-proj">${esc(p.name || '')}</div>
      <div class="rp-pj-editor-body">
        <div id="rp-tk-list"></div>
        ${code ? `
        <div class="rp-tk-add">
          <input type="text" id="rp-tk-new" class="rp-input"
            placeholder="新任务名称，如 现场勘测 / 脚本撰写" />
          <button id="rp-tk-add" class="rp-btn primary">添加</button>
        </div>` : '<div class="rp-hint">该项目没有编号，挂不上任务 —— 请先在项目编辑里补上编号。</div>'}
      </div>
      <div class="rp-hint">任务用于员工填报时细分工作内容。员工不选任务也可以直接以整个项目提交。</div>
    </div>`;
  document.body.appendChild(box);

  const close = () => box.remove();
  document.getElementById('rp-tke-close').addEventListener('click', close);
  box.addEventListener('click', e => { if (e.target === box) close(); });

  function paint() {
    const el = document.getElementById('rp-tk-list');
    if (!el) return;
    el.innerHTML = tasks.length
      ? tasks.map(t => `
        <div class="rp-mini-row rp-staff-row">
          <span class="rp-proj-name">${esc(t.name)}</span>
          <span class="rp-proj-edit" data-tk-rename="${t.id}">改名</span>
          <span class="rp-proj-edit" data-tk-del="${t.id}">删除</span>
        </div>`).join('')
      : '<div class="rp-empty-mini">还没有任务</div>';

    // 改名：行内编辑（Tauri 里 window.prompt 不可靠，不用）
    el.querySelectorAll('[data-tk-rename]').forEach(b =>
      b.addEventListener('click', () => {
        const t = tasks.find(x => String(x.id) === String(b.dataset.tkRename));
        if (!t) return;
        const nameSpan = b.closest('.rp-mini-row').querySelector('.rp-proj-name');
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.className = 'rp-input rp-tk-inline';
        inp.value = t.name;
        nameSpan.replaceWith(inp);
        inp.focus();
        inp.select();

        let done = false;
        const commit = async ok => {
          if (done) return;
          done = true;
          const v = (inp.value || '').trim();
          if (!ok || !v || v === t.name) { paint(); return; }
          try {
            await updateProjectTask(t.id, { name: v });
            t.name = v;
            toast('已改名 ✓');
          } catch (e) { toast('改名失败：' + e.message, 'err'); }
          paint();
        };
        inp.addEventListener('keydown', e => {
          if (e.key === 'Enter') commit(true);
          else if (e.key === 'Escape') commit(false);
        });
        inp.addEventListener('blur', () => commit(true));
      }));

    el.querySelectorAll('[data-tk-del]').forEach(b =>
      b.addEventListener('click', async () => {
        const t = tasks.find(x => String(x.id) === String(b.dataset.tkDel));
        if (!t) return;
        if (!confirm(`确定删除任务「${t.name}」？\n已提交的填报记录不受影响（记录里保留了当时的任务名）。`)) return;
        try {
          await deleteProjectTask(t.id);
          const i = tasks.indexOf(t);
          if (i > -1) tasks.splice(i, 1);
          toast('已删除');
          paint();
          refreshTaskBadge(p.id, tasks.length);   // 背景计数徽章就地更新，不重建子页
        } catch (e) { toast('删除失败：' + e.message, 'err'); }
      }));
  }

  paint();

  const addBtn = document.getElementById('rp-tk-add');
  if (addBtn) {
    const doAdd = async () => {
      const inp = document.getElementById('rp-tk-new');
      const name = (inp.value || '').trim();
      if (!name) { toast('请先填写任务名称', 'err'); return; }
      try {
        const r = await addProjectTask({ project_code: code, name });
        const created = Array.isArray(r) ? r[0] : null;
        tasks.push(created || { id: 'tmp-' + Date.now(), name });
        inp.value = '';
        toast('已添加 ✓');
        paint();
        refreshTaskBadge(p.id, tasks.length);   // 背景计数徽章就地更新，不重建子页
      } catch (e) { toast('添加失败：' + e.message, 'err'); }
    };
    addBtn.addEventListener('click', doAdd);
    document.getElementById('rp-tk-new').addEventListener('keydown', e => {
      if (e.key === 'Enter') doAdd();
    });
  }
}

/* ============ 子页 5：客户管理 ============ */

async function renderCustomersSub(host, t) {
  const [list, projList] = await Promise.all([fetchCustomersAll(), fetchProjectsFull()]);
  if (staleView(t)) return;
  const projects = projList || [];
  const norm = s => String(s || '').trim();
  const tally = {};
  projects.forEach(p => {
    const c = norm(p.customer);
    if (c) tally[c] = (tally[c] || 0) + 1;
  });
  const missing = Object.keys(tally).filter(c => !list.some(x => norm(x.name) === c));

  host.innerHTML = `
    <div class="rp-form">
      <div class="rp-subhead">新增客户 <span class="rp-adm-badge">管理员</span></div>
      <div class="rp-pj-grid rp-staff-grid">
        <label class="rp-fld"><span>客户名称 *</span>
          <input id="rp-cu-name" class="rp-input" placeholder="如 GE医疗" /></label>
        <label class="rp-fld"><span>联系人（可选）</span>
          <input id="rp-cu-contact" class="rp-input" placeholder="如 张工 / 采购部李经理，多人用 / 分隔" /></label>
        <label class="rp-fld"><span>排序（可选）</span>
          <input id="rp-cu-sort" class="rp-input" type="number" placeholder="如 10" /></label>
      </div>
      <div class="rp-hint">「排序」数字越小越靠前，留空默认 999。「联系人」在客户跟进里选中该客户时自动带出，可改。<br>客户清单用于「客户跟进」的选择列表。删除客户只影响选择列表，不会动已提交的跟进记录和项目数据。</div>
      <div class="rp-form-actions">
        <button id="rp-cu-add" class="rp-btn primary">添加客户</button>
        ${missing.length ? `<button id="rp-cu-sync" class="rp-btn">同步项目中的 ${missing.length} 个客户</button>` : ''}
      </div>
      ${missing.length ? `<div class="rp-hint">项目里已用到但不在客户清单中：${missing.map(esc).join('、')}</div>` : ''}
    </div>
    <div class="rp-list-head">客户清单 <span class="rp-count">${list.length}</span></div>
    <div class="rp-mini">${
      list.length
        ? list.map(c => customerRow(c, tally[norm(c.name)] || 0)).join('')
        : '<div class="rp-empty small">暂无客户</div>'
    }</div>
  `;

  document.getElementById('rp-cu-add').addEventListener('click', async () => {
    const name = norm(document.getElementById('rp-cu-name').value);
    if (!name) { toast('请填写客户名称', 'err'); return; }
    if (list.some(x => norm(x.name) === name)) { toast('该客户已存在', 'err'); return; }
    const sortRaw = document.getElementById('rp-cu-sort').value.trim();
    const contact = norm(document.getElementById('rp-cu-contact').value);
    try {
      await addCustomer(name, contact || null);
      if (sortRaw) {
        // 排序值单独补一次（addCustomer 只传 name，避免 undefined 覆盖默认值）
        const all = (await fetchCustomersAll()) || [];
        const it = all.find(x => norm(x.name) === name);
        if (it) await updateCustomer(it.id, { sort_order: Number(sortRaw) });
      }
      toast('已添加 ✓');
      window.dispatchEvent(new CustomEvent('qn:customers-changed'));
      await renderSub(true);
    } catch (e) { toast('添加失败：' + e.message, 'err'); }
  });

  const syncBtn = document.getElementById('rp-cu-sync');
  if (syncBtn) {
    syncBtn.addEventListener('click', async () => {
      try {
        for (const name of missing) await addCustomer(name);
        toast(`已同步 ${missing.length} 个客户 ✓`);
        window.dispatchEvent(new CustomEvent('qn:customers-changed'));
        await renderSub(true);
      } catch (e) { toast('同步失败：' + e.message, 'err'); }
    });
  }

  host.querySelectorAll('[data-cu-edit]').forEach(b =>
    b.addEventListener('click', () => openCustomerEditor(b.dataset.cuEdit, list)));

  host.querySelectorAll('[data-cu-del]').forEach(b =>
    b.addEventListener('click', async () => {
      const c = list.find(x => String(x.id) === b.dataset.cuDel);
      if (!c) return;
      const n = tally[norm(c.name)] || 0;
      const extra = n ? `\n注意：有 ${n} 个项目属于该客户，删除后这些项目不受影响，仅从跟进选择列表移除。` : '';
      if (!confirm(`确定删除客户「${c.name}」？${extra}`)) return;
      try {
        await deleteCustomer(c.id);
        toast('已删除');
        window.dispatchEvent(new CustomEvent('qn:customers-changed'));
        await renderSub(true);
      } catch (e) { toast('删除失败：' + e.message, 'err'); }
    }));
}

function customerRow(c, projCount) {
  return `<div class="rp-mini-row rp-staff-row" title="「编辑」改名称 / 联系人 / 排序，「删除」从清单移除">
    <span class="rp-proj-name">${esc(c.name)}</span>
    ${c.contact ? `<span class="rp-proj-meta">👤 ${esc(c.contact)}</span>` : ''}
    <span class="rp-proj-meta">${projCount ? `${projCount} 个项目` : '暂无项目'}</span>
    <span class="rp-proj-edit" data-cu-edit="${c.id}">编辑</span>
    <span class="rp-proj-edit" data-cu-del="${c.id}">删除</span>
  </div>`;
}

/** 客户编辑覆盖层（改名 / 排序） */
function openCustomerEditor(id, list) {
  const c = list.find(x => String(x.id) === String(id));
  if (!c) return;
  const old = document.getElementById('rp-cu-editor');
  if (old) old.remove();

  const box = document.createElement('div');
  box.id = 'rp-cu-editor';
  box.className = 'rp-pj-editor';
  box.innerHTML = `
    <div class="rp-pj-editor-inner" style="max-width:26rem">
      <div class="rp-pj-editor-head">
        <b>编辑客户</b>
        <span class="rp-proj-code">${esc(c.name)}</span>
        <button id="rp-cue-close" class="rp-icon-btn" title="关闭">✕</button>
      </div>
      <div class="rp-pj-editor-body">
        <div class="rp-pj-grid rp-staff-grid">
          <label class="rp-fld"><span>客户名称</span>
            <input id="rp-cue-name" class="rp-input" value="${esc(c.name)}" /></label>
          <label class="rp-fld"><span>联系人</span>
            <input id="rp-cue-contact" class="rp-input" value="${esc(c.contact ?? '')}"
                   placeholder="如 张工 / 采购部李经理" /></label>
          <label class="rp-fld"><span>排序</span>
            <input id="rp-cue-sort" class="rp-input" type="number" value="${c.sort_order ?? 999}" /></label>
        </div>
        <div class="rp-hint">改名只影响客户清单与后续选择，已提交的跟进记录保留原名称。联系人在「客户跟进」里选该客户时自动带出。</div>
      </div>
      <div class="rp-form-actions">
        <button id="rp-cue-save" class="rp-btn primary">保存修改</button>
      </div>
    </div>`;
  document.body.appendChild(box);

  const close = () => box.remove();
  document.getElementById('rp-cue-close').addEventListener('click', close);
  box.addEventListener('click', e => { if (e.target === box) close(); });

  document.getElementById('rp-cue-save').addEventListener('click', async () => {
    const name = document.getElementById('rp-cue-name').value.trim();
    if (!name) { toast('客户名称不能为空', 'err'); return; }
    const sortRaw = document.getElementById('rp-cue-sort').value.trim();
    const contact = document.getElementById('rp-cue-contact').value.trim();
    const patch = {
      name,
      contact: contact || null,
      sort_order: sortRaw === '' ? 999 : Number(sortRaw),
    };
    try {
      await updateCustomer(c.id, patch);
      toast('已保存 ✓');
      window.dispatchEvent(new CustomEvent('qn:customers-changed'));
      close();
      await renderSub(true);
    } catch (e) { toast('保存失败：' + e.message, 'err'); }
  });
}

/* ============ 子页 4：人员管理 ============ */

/* 职位字段：用下拉（select）而不是带候选词的 input —— input+datalist 会随输入实时筛选，
   只剩匹配项，看不到全部职位。select 里始终是全量职位，点开即可挑。
   「＋ 其他职位…」保留新增职位的余地（选中后出现一个手动输入框）。 */
const ROLE_OTHER = '__other__';

/** 职位候选：管理员置顶 + 名册里在用的职位 + 当前值（保证编辑时不会丢） */
function roleOptions(staffList, current) {
  const list = ['管理员'];
  (staffList || []).forEach(s => { if (s.role && !list.includes(s.role)) list.push(s.role); });
  if (current && !list.includes(current)) list.push(current);
  return list;
}

function roleFieldHtml(selId, otherId, current, staffList) {
  const opts = roleOptions(staffList, current);
  return `<label class="rp-fld"><span>职位</span>
          <select id="${selId}" class="rp-select">
            <option value=""${current ? '' : ' selected'}>（未设置）</option>
            ${opts.map(r => `<option value="${esc(r)}"${r === current ? ' selected' : ''}>${esc(r)}</option>`).join('')}
            <option value="${ROLE_OTHER}">＋ 其他职位…</option>
          </select></label>
        <div class="rp-fld" id="${otherId}-wrap" style="display:none">
          <span>其他职位名称</span>
          <input id="${otherId}" class="rp-input" placeholder="手动输入职位名" /></div>`;
}

/** 下拉与「其他职位」输入框联锁：只有选中「＋ 其他职位…」才显示输入框 */
function bindRoleField(root, selId, otherId) {
  const sel = root.querySelector('#' + selId);
  const wrap = root.querySelector('#' + otherId + '-wrap');
  if (!sel || !wrap) return;
  const sync = () => { wrap.style.display = sel.value === ROLE_OTHER ? '' : 'none'; };
  sel.addEventListener('change', sync);
  sync();
}

function readRoleField(root, selId, otherId) {
  const sel = root.querySelector('#' + selId);
  if (!sel) return null;
  if (sel.value === ROLE_OTHER) {
    return (root.querySelector('#' + otherId)?.value || '').trim() || null;
  }
  return sel.value.trim() || null;
}

async function renderStaffSub(host, t) {
  const list = (await fetchStaffAll()) || [];
  if (staleView(t)) return;
  const active = list.filter(s => s.active);
  const off = list.filter(s => !s.active);

  host.innerHTML = `
    <div class="rp-form">
      <div class="rp-subhead">新增人员 <span class="rp-adm-badge">管理员</span></div>
      <div class="rp-pj-grid rp-staff-grid">
        <label class="rp-fld"><span>姓名 *</span>
          <input id="rp-st-name" class="rp-input" placeholder="必填" /></label>
        ${roleFieldHtml('rp-st-role', 'rp-st-role-other', '', list)}
        <label class="rp-fld"><span>分组</span>
          <input id="rp-st-dept" class="rp-input" placeholder="如 开发 / 策划" /></label>
      </div>
      <div class="rp-form-actions">
        <button id="rp-st-add" class="rp-btn primary">添加人员</button>
      </div>
      <div class="rp-hint">「分组」决定选人下拉里的分组归属。职位为纯「客户经理」或「管理员」的成员不参与每日填报（免填）；复合角色如「客户经理/项目经理」仍需填报。</div>
    </div>
    <div class="rp-list-head">在职 <span class="rp-count">${active.length}</span></div>
    <div class="rp-mini">${active.map(staffRow).join('')}</div>
    ${off.length ? `
    <div class="rp-list-head muted">已停用 <span class="rp-count">${off.length}</span></div>
    <div class="rp-mini">${off.map(staffRow).join('')}</div>` : ''}
  `;

  bindRoleField(host, 'rp-st-role', 'rp-st-role-other');

  document.getElementById('rp-st-add').addEventListener('click', async () => {
    const name = document.getElementById('rp-st-name').value.trim();
    if (!name) { toast('请填写姓名', 'err'); return; }
    if (list.some(s => s.name === name)) { toast('已有同名人员，请直接编辑', 'err'); return; }
    const payload = {
      name,
      role: readRoleField(host, 'rp-st-role', 'rp-st-role-other'),
      dept: document.getElementById('rp-st-dept').value.trim() || null,
      active: true,
    };
    try {
      await addStaff(payload);
      toast('已添加 ✓');
      window.dispatchEvent(new CustomEvent('qn:staff-changed'));
      await renderSub(true);
    } catch (e) { toast('添加失败：' + e.message, 'err'); }
  });

  host.querySelectorAll('[data-st-edit]').forEach(b =>
    b.addEventListener('click', () => openStaffEditor(b.dataset.stEdit, list)));

  host.querySelectorAll('[data-st-toggle]').forEach(b =>
    b.addEventListener('click', async () => {
      const s = list.find(x => String(x.id) === b.dataset.stToggle);
      if (!s) return;
      const toActive = !s.active;
      if (!confirm(toActive
        ? `恢复「${s.name}」为在职？`
        : `停用「${s.name}」？\n停用后不再出现在选人列表和汇总中，历史记录保留。`)) return;
      try {
        await updateStaff(s.id, { active: toActive });
        toast(toActive ? '已恢复' : '已停用');
        window.dispatchEvent(new CustomEvent('qn:staff-changed'));
        await renderSub(true);
      } catch (e) { toast('操作失败：' + e.message, 'err'); }
    }));

  // 物理删除人员（与「停用」区分：停用可恢复，删除不可逆）
  host.querySelectorAll('[data-st-del]').forEach(b =>
    b.addEventListener('click', async () => {
      const s = list.find(x => String(x.id) === b.dataset.stDel);
      if (!s) return;
      let extra = '\n历史填报记录保留（记录里存的是当时的姓名）。';
      if ((localStorage.getItem('report_user') || '') === s.name) {
        extra += '\n注意：这是你当前登录的身份，删除后需要重新选择身份。';
      }
      if (!confirm(`彻底删除人员「${s.name}」？${extra}\n如果只是暂时不在职，用「停用」更合适（可恢复）。`)) return;
      try {
        await deleteStaff(s.id);
        toast('已删除');
        window.dispatchEvent(new CustomEvent('qn:staff-changed'));
        await renderSub(true);
      } catch (e) { toast('删除失败：' + e.message, 'err'); }
    }));
}

function staffRow(s) {
  return `<div class="rp-mini-row rp-staff-row" title="点击「编辑」修改姓名/职位/分组">
    <span class="rp-proj-name">${esc(s.name)}${s.is_admin ? ' 👑' : ''}</span>
    <span class="rp-proj-meta">${esc(s.role || '')}</span>
    <span class="rp-proj-meta">${esc(s.dept || '')}</span>
    ${s.active ? '' : '<span class="rp-tag alt">已停用</span>'}
    <span class="rp-proj-edit" data-st-edit="${s.id}">编辑</span>
    <span class="rp-proj-edit" data-st-toggle="${s.id}">${s.active ? '停用' : '恢复'}</span>
    <span class="rp-proj-edit danger" data-st-del="${s.id}">删除</span>
  </div>`;
}

/** 人员编辑覆盖层（与项目编辑同款交互） */
function openStaffEditor(id, list) {
  const s = list.find(x => String(x.id) === String(id));
  if (!s) return;
  const old = document.getElementById('rp-st-editor');
  if (old) old.remove();

  const box = document.createElement('div');
  box.id = 'rp-st-editor';
  box.className = 'rp-pj-editor';
  box.innerHTML = `
    <div class="rp-pj-editor-inner" style="max-width:26rem">
      <div class="rp-pj-editor-head">
        <b>编辑人员</b>
        <span class="rp-proj-code">${esc(s.name)}</span>
        <button id="rp-ste-close" class="rp-icon-btn" title="关闭">✕</button>
      </div>
      <div class="rp-pj-editor-body">
        <div class="rp-pj-grid rp-staff-grid">
          <label class="rp-fld"><span>姓名</span>
            <input id="rp-ste-name" class="rp-input" value="${esc(s.name)}" /></label>
          ${roleFieldHtml('rp-ste-role', 'rp-ste-role-other', s.role, list)}
          <label class="rp-fld"><span>分组</span>
            <input id="rp-ste-dept" class="rp-input" value="${esc(s.dept || '')}" /></label>
        </div>
        <div class="rp-hint">
          改成纯「客户经理」或「管理员」即免填每日任务；改名不影响历史记录（历史仍显示原名）。
        </div>
      </div>
      <div class="rp-form-actions">
        <button id="rp-ste-save" class="rp-btn primary">保存修改</button>
      </div>
    </div>`;
  document.body.appendChild(box);

  bindRoleField(box, 'rp-ste-role', 'rp-ste-role-other');

  const close = () => box.remove();
  document.getElementById('rp-ste-close').addEventListener('click', close);
  box.addEventListener('click', e => { if (e.target === box) close(); });

  document.getElementById('rp-ste-save').addEventListener('click', async () => {
    const name = document.getElementById('rp-ste-name').value.trim();
    if (!name) { toast('姓名不能为空', 'err'); return; }
    const patch = {
      name,
      role: readRoleField(box, 'rp-ste-role', 'rp-ste-role-other'),
      dept: document.getElementById('rp-ste-dept').value.trim() || null,
    };
    try {
      await updateStaff(s.id, patch);
      toast('已保存 ✓');
      window.dispatchEvent(new CustomEvent('qn:staff-changed'));
      close();
      await renderSub(true);
    } catch (e) { toast('保存失败：' + e.message, 'err'); }
  });
}

function miniRow(p, taskCount = 0) {
  const money = p.po_amount ? `¥${Number(p.po_amount).toLocaleString('zh-CN')}` : '';
  const cls = p.archived ? ' rp-mini-row-archived' : '';
  const tk = `<span class="rp-tk-btn${taskCount ? ' has' : ''}" data-tasks="${p.id}"
    title="管理该项目的任务">${taskCount ? `任务 ${taskCount}` : '＋任务'}</span>`;
  return `<div class="rp-mini-row${cls}" data-id="${p.id}" title="点击编辑">
    <span class="rp-proj-code">${esc(p.code || '')}</span>
    <span class="rp-proj-name">${esc(p.name || '')}</span>
    <span class="rp-proj-meta">${esc(p.project_mgr || '')}</span>
    <span class="rp-proj-money">${money}</span>
    ${tk}
    <span class="rp-proj-edit">${p.archived ? '已归档' : '编辑'}</span>
    <span class="rp-proj-edit danger" data-pj-del="${p.id}">删除</span>
  </div>`;
}

/* ============ 导出 Excel ============ */

/** 项目行 → 表格列（对齐腾讯文档项目总表的列名与顺序） */
function projectToRow(p, idx) {
  return {
    序号: idx,
    项目编号: p.code || '',
    项目名称: p.name || '',
    客户: p.customer || '',
    客户经理: p.account_mgr || '',
    项目经理: p.project_mgr || '',
    客户联系人: p.contact || '',
    PO金额: p.po_amount ?? '',
    '税金6%': p.tax_amount ?? '',
    外包金额: p.outsource_amount ?? '',
    签单额: p.signed_amount ?? '',
    有效签单额: p.valid_amount ?? '',
    状态: p.status || '',
    预算表: p.budget_link || '',
    GR: p.gr_text || '',
    发票: p.invoice_text || '',
    备注1: p.note1 || '',
    备注2: p.note2 || '',
    备注3: p.note3 || '',
    本周执行进度: p.progress || '',
  };
}

/** 金额列小计行 */
function withTotal(rows) {
  const keys = ['PO金额', '税金6%', '外包金额', '签单额', '有效签单额'];
  const total = { 序号: '', 项目编号: '小计', 项目名称: '', 客户: '', 客户经理: '', 项目经理: '', 客户联系人: '' };
  keys.forEach(k => {
    const s = rows.reduce((a, r) => a + (typeof r[k] === 'number' ? r[k] : 0), 0);
    total[k] = Math.round(s * 100) / 100;
  });
  ['状态', '预算表', 'GR', '发票', '备注1', '备注2', '备注3', '本周执行进度'].forEach(k => total[k] = '');
  return rows.concat([total]);
}

function projectRows(plist) {
  return plist.map((p, i) => projectToRow(p, i + 1));
}

const PROJECT_COLS = ['序号', '项目编号', '项目名称', '客户', '客户经理', '项目经理', '客户联系人',
  'PO金额', '税金6%', '外包金额', '签单额', '有效签单额', '状态', '预算表', 'GR', '发票',
  '备注1', '备注2', '备注3', '本周执行进度'];

function projectWidths(cols) {
  return cols.map(c => {
    if (['项目名称', '客户联系人'].includes(c)) return 34;
    if (['备注1', '备注2', '备注3', '本周执行进度'].includes(c)) return 30;
    if (['PO金额', '税金6%', '外包金额', '签单额', '有效签单额'].includes(c)) return 13;
    if (c === '序号') return 6;
    return 13;
  });
}

/* ── 客户跟进 / 完工回访：导出用列定义（无数据时也输出表头）── */
const FOLLOW_COLS = ['日期', '跟进人', '客户', '联系人', '项目编号', '跟进内容', '客户反馈'];
const FOLLOW_WIDTHS = [12, 10, 20, 12, 14, 40, 32];
const REVIEW_COLS = ['日期', '回访人', '项目编号', '项目名称', '客户', '评分', '回访内容'];
const REVIEW_WIDTHS = [12, 10, 14, 34, 20, 8, 40];

/** 客户跟进记录 → 表格行 */
function followToRow(f) {
  return {
    日期: String(f.follow_date || '').slice(0, 10),
    跟进人: f.user_name || '',
    客户: f.customer || '',
    联系人: f.contact || '',
    项目编号: f.project_code || '',
    跟进内容: f.content || '',
    客户反馈: f.feedback || '',
  };
}

/** 完工回访记录 → 表格行 */
function reviewToRow(r) {
  return {
    日期: String(r.review_date || '').slice(0, 10),
    回访人: r.reviewer || '',
    项目编号: r.project_code || '',
    项目名称: r.project_name || '',
    客户: r.customer || '',
    评分: r.score == null ? '' : Number(r.score),
    回访内容: r.content || '',
  };
}

async function doExport() {
  const btn = document.getElementById('rp-adm-export');
  btn.disabled = true;
  btn.textContent = '导出中…';
  try {
    const to = today();
    const from = rangeStart();

    // ── 客户跟进 / 完工回访（与页面统计同一数据范围）──
    // 单表读取失败不阻断整体导出，只在结果提示里标出来
    let followRows = [];
    let reviewRows = [];
    let sideErr = '';
    let truncated = false;
    // 项目全字段（金额等）与另外两张表并行取，不再串行等待
    const projPromise = (allProjects && allProjects.length)
      ? Promise.resolve(null)
      : fetchProjectsFull().catch(() => null);
    try {
      const [fu, rv] = await Promise.all([
        fetchFollowupsInRange(from, to, LIMIT_SIDE),
        fetchReviewsInRange(from, to, LIMIT_SIDE),
      ]);
      followRows = fu || [];
      reviewRows = rv || [];
      truncated = followRows.length >= LIMIT_SIDE || reviewRows.length >= LIMIT_SIDE
        || (rows || []).length >= LIMIT_TASKS;
    } catch (e) {
      sideErr = (e && e.message) ? e.message : '读取失败';
    }

    const pFull = await projPromise;
    if (pFull) allProjects = pFull;

    // ── 项目部分（数据源：projects 缓存，91 条）──
    const pAll = [...(allProjects || [])].sort((a, b) =>
      (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.id - b.id);
    const pExec = pAll.filter(p => p.stage === 'exec');
    const pPresale = pAll.filter(p => p.stage === 'presale');
    const overview = pAll.map((p, i) => ({
      ...projectToRow(p, i + 1),
      阶段: p.stage === 'exec' ? '执行' : '售前',
    }));

    // ── 填报部分（数据源：rows —— 当前范围下的填报缓存）──
    const detail = [...rows].sort((a, b) => {
      const d = String(b.entry_date).slice(0, 10).localeCompare(String(a.entry_date).slice(0, 10));
      if (d) return d;
      return a.user_name.localeCompare(b.user_name, 'zh');
    }).map(r => ({
      日期: String(r.entry_date).slice(0, 10),
      姓名: r.user_name,
      项目编号: r.project_code || '',
      项目名称: r.project_name || '',
      任务: r.task_name || '',
      工作内容: r.task_text || '',
      '工时(h)': r.hours == null ? '' : Number(r.hours),
      来源: r.source || '',
    }));

    const byPerson = {};
    rows.forEach(r => {
      const p = byPerson[r.user_name] = byPerson[r.user_name] || { n: 0, days: new Set(), h: 0 };
      p.n++;
      p.days.add(String(r.entry_date).slice(0, 10));
      if (r.hours != null) p.h += Number(r.hours);
    });
    const summary = staffAll.filter(s => s.active).map(s => {
      const p = byPerson[s.name];
      const exempt = isExemptRole(s.role); // 免填人员不参与填报
      return {
        姓名: s.name,
        岗位: s.role || '',
        分组: s.dept || '',
        填报条数: p ? p.n : 0,
        涉及天数: p ? p.days.size : 0,
        '工时合计(h)': p && p.h > 0 ? Math.round(p.h * 100) / 100 : '',
        今日已报: exempt ? '免填' : (unsubmitted.some(u => u.name === s.name) ? '' : '是'),
      };
    });

    const byProj = {};
    rows.forEach(r => {
      const k = r.project_code || '（未指定）';
      const p = byProj[k] = byProj[k] || { name: r.project_name || '', who: new Set(), n: 0, h: 0 };
      p.who.add(r.user_name);
      p.n++;
      if (r.hours != null) p.h += Number(r.hours);
    });
    const projSummary = Object.keys(byProj).sort().map(k => ({
      项目编号: k,
      项目名称: byProj[k].name,
      参与人数: byProj[k].who.size,
      参与人: [...byProj[k].who].join('、'),
      填报条数: byProj[k].n,
      '工时合计(h)': byProj[k].h > 0 ? Math.round(byProj[k].h * 100) / 100 : '',
    }));

    const scopeTag = rangeDays === RANGE_ALL ? '全部' : `近${rangeDays}天`;
    const fname = `项目管理工作台_${scopeTag}_${to}.xlsx`;
    const saved = await exportXlsx(fname, [
      { name: '执行项目', rows: withTotal(projectRows(pExec)), widths: projectWidths(PROJECT_COLS) },
      { name: '售前项目', rows: withTotal(projectRows(pPresale)), widths: projectWidths(PROJECT_COLS) },
      { name: '项目总览', rows: overview, widths: [...projectWidths(PROJECT_COLS), 8] },
      { name: '填报明细', rows: detail, widths: [12, 10, 14, 30, 20, 40, 9, 10] },
      { name: '人员汇总', rows: summary, widths: [10, 16, 12, 10, 10, 12, 10] },
      { name: '项目汇总', rows: projSummary, widths: [14, 34, 10, 30, 10, 12] },
      { name: '客户跟进', rows: followRows.map(followToRow), widths: FOLLOW_WIDTHS, headers: FOLLOW_COLS },
      { name: '完工回访', rows: reviewRows.map(reviewToRow), widths: REVIEW_WIDTHS, headers: REVIEW_COLS },
    ]);
    const tail = sideErr
      ? `（客户跟进/完工回访未取到：${sideErr}）`
      : (truncated ? '（数据量达单次上限，可能未取全）' : '');
    toast(saved ? `已导出：${saved}${tail}` : `已导出 ✓${tail}`);
  } catch (e) {
    toast('导出失败：' + e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '导出 Excel';
  }
}
