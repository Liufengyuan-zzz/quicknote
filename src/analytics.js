/**
 * analytics.js — 数据分析可视化工作台（管理员中心「数据分析」子页）
 *
 * 纯前端、零依赖：图表全部手写 SVG / CSS 实现，复用 cloud.js 的缓存数据层，
 * 登录与 RLS 门禁已由 cloud.js 兜住，这里只负责「取数 → 聚合 → 画图」。
 *
 * 数据源（全部走已有 fetch 函数）：
 *   - projects           项目全字段（含金额、阶段、状态、客户）
 *   - task_entries       每日填报（条数、工时）
 *   - customer_followups 客户跟进
 *   - completion_reviews 完工回访（含满意度评分）
 *
 * 时间范围：最近 7 / 14 / 30 天 / 全部 —— 只作用于「填报 / 跟进 / 回访」这类
 * 时间序列指标；项目金额、阶段、客户分布等清单型指标始终全量统计。
 */

import {
  fetchProjectsFull, fetchTasksInRange,
  fetchFollowupsInRange, fetchReviewsInRange,
} from './cloud.js';
import { staleView } from './view-guard.js';

/* ============ 基础工具 ============ */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function round1(n) { return Math.round((Number(n) || 0) * 10) / 10; }

function sum(list, fn) {
  return list.reduce((a, x) => a + (Number(fn(x)) || 0), 0);
}

/** 金额：大数折成 万 / 亿，其余千分位 */
function fmtMoney(n) {
  const v = Number(n) || 0;
  if (v >= 1e8) return '¥' + round1(v / 1e8) + '亿';
  if (v >= 1e4) return '¥' + round1(v / 1e4) + '万';
  return '¥' + Math.round(v).toLocaleString('zh-CN');
}

function fmtH(h) { return round1(h) + 'h'; }

/** 把最大值向上取整到「好看」的刻度（1 / 2 / 5 × 10^k） */
function niceMax(v) {
  if (v <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / pow;
  const m = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return m * pow;
}

function fmtAxis(v) {
  return Number.isInteger(v) ? String(v) : String(round1(v));
}

/* ============ 配色（与 light 主题一致） ============ */

const C = {
  accent: '#2563eb', accentL: '#60a5fa', accentLL: '#bfdbfe',
  green: '#16a34a', amber: '#f59e0b', teal: '#0d9488',
  violet: '#7c3aed', rose: '#e11d48', sky: '#0ea5e9',
  gray: '#9ca3af',
  text: '#111', text2: '#666', text3: '#aaa',
  border: '#ececec',
};
const PALETTE = [C.accent, C.amber, C.teal, C.violet, C.rose, C.sky, C.green, C.gray];

/* ============ 时间范围 ============ */

const RANGE_OPTS = [
  [7, '最近 7 天'], [14, '最近 14 天'], [30, '最近 30 天'], [0, '全部数据'],
];
const RANGE_ALL = 0;
let rangeDays = 30;   // 跨切页保留

/* ============ 图表原语（SVG / CSS） ============ */

/** 柱状（条数）+ 折线（工时）双轴趋势图 */
function trendSvg({ labels, bars, line }) {
  const n = labels.length;
  if (!n) return '<div class="an-empty">暂无填报数据</div>';

  const W = 640, H = 240;
  const padL = 40, padR = 40, padT = 16, padB = 28;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const maxB = niceMax(Math.max(...bars, 1));
  const maxL = niceMax(Math.max(...line, 1));
  const x = i => padL + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const yB = v => padT + plotH - (v / maxB) * plotH;
  const yL = v => padT + plotH - (v / maxL) * plotH;

  // 左轴网格线（条数）
  let grid = '';
  [0.5, 1].forEach(f => {
    const y = yB(maxB * f);
    grid += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" stroke="${C.border}" stroke-width="1"/>` +
      `<text x="${padL - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="9" fill="${C.text3}">${fmtAxis(maxB * f)}</text>`;
  });
  grid += `<line x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${padT + plotH}" stroke="#e5e5e5" stroke-width="1"/>`;

  // 柱（条数）
  const barW = Math.max(3, (plotW / n) * 0.6);
  const barsEl = bars.map((v, i) => {
    const xc = x(i);
    const h = Math.max(0, plotH - (v / maxB) * plotH);
    return `<rect x="${(xc - barW / 2).toFixed(1)}" y="${yB(v).toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${C.accent}" opacity="0.85"><title>${esc(labels[i])}：${v} 条</title></rect>`;
  }).join('');

  // 折线（工时，右轴）
  let lineEl = '';
  if (line.some(v => v > 0)) {
    const pts = line.map((v, i) => `${x(i).toFixed(1)},${yL(v).toFixed(1)}`).join(' ');
    lineEl += `<polyline points="${pts}" fill="none" stroke="${C.amber}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    lineEl += line.map((v, i) => v > 0
      ? `<circle cx="${x(i).toFixed(1)}" cy="${yL(v).toFixed(1)}" r="2.2" fill="${C.amber}"><title>${esc(labels[i])}：${round1(v)} h</title></circle>` : '').join('');
    lineEl += `<text x="${W - padR + 6}" y="${padT + 3}" font-size="9" fill="${C.amber}">${fmtAxis(maxL)}h</text>`;
  }

  // X 轴标签（最多约 8 个，避免重叠）
  const step = Math.max(1, Math.ceil(n / 8));
  const xlbl = labels.map((lb, i) => {
    if (i % step !== 0 && i !== n - 1) return '';
    return `<text x="${x(i).toFixed(1)}" y="${H - 10}" text-anchor="middle" font-size="9" fill="${C.text3}">${esc(lb)}</text>`;
  }).join('');

  return `<svg viewBox="0 0 ${W} ${H}" class="an-svg" preserveAspectRatio="xMidYMid meet" role="img">${grid}${barsEl}${lineEl}${xlbl}</svg>`;
}

/** 环形图：segments = [{label, value, color}] */
function donutSvg(segments, centerLabel) {
  const total = segments.reduce((a, s) => a + s.value, 0);
  if (!total) return '<div class="an-empty">暂无项目</div>';
  const size = 160, stroke = 26;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  let off = 0;
  const segEl = segments.filter(s => s.value > 0).map(s => {
    const len = (s.value / total) * c;
    const el = `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${s.color}" stroke-width="${stroke}"
      stroke-dasharray="${len.toFixed(2)} ${(c - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}"
      transform="rotate(-90 ${size / 2} ${size / 2})"><title>${esc(s.label)}：${s.value}（${Math.round(s.value / total * 100)}%）</title></circle>`;
    off += len;
    return el;
  }).join('');
  const center = `<text x="${size / 2}" y="${size / 2 - 4}" text-anchor="middle" font-size="26" font-weight="600" fill="${C.text}">${total}</text>` +
    `<text x="${size / 2}" y="${size / 2 + 16}" text-anchor="middle" font-size="11" fill="${C.text3}">${esc(centerLabel || '个项目')}</text>`;
  return `<svg viewBox="0 0 ${size} ${size}" class="an-svg an-donut" role="img">${segEl}${center}</svg>`;
}

/** 环形图图例 */
function legendHtml(segments, fmt) {
  const total = segments.reduce((a, s) => a + s.value, 0) || 1;
  return segments.map(s => `
    <div class="an-legend-item">
      <i style="background:${s.color}"></i>
      <span class="an-legend-label">${esc(s.label)}</span>
      <span class="an-legend-val">${esc(fmt ? fmt(s.value) : String(s.value))}
        <em>${Math.round(s.value / total * 100)}%</em></span>
    </div>`).join('');
}

/** 横向条形图：rows = [{label, value, hint, color}] */
function hBarList(rows, fmt) {
  if (!rows.length) return '<div class="an-empty">暂无数据</div>';
  const max = Math.max(1, ...rows.map(r => r.value));
  return rows.map(r => `
    <div class="an-hbar" title="${esc(r.hint || '')}">
      <span class="an-hbar-label">${esc(r.label)}</span>
      <span class="an-hbar-track">
        <span class="an-hbar-fill" style="width:${(r.value / max * 100).toFixed(1)}%;background:${r.color || C.accent}"></span>
      </span>
      <span class="an-hbar-val">${esc(fmt ? fmt(r.value) : String(r.value))}</span>
    </div>`).join('');
}

/** 图例：柱 = 条数，折线 = 工时 */
function trendLegend() {
  return `<div class="an-trend-legend">
    <span><i class="an-sq" style="background:${C.accent}"></i>填报条数</span>
    <span><i class="an-line"></i>填报工时（右轴）</span>
  </div>`;
}

/* ============ 数据聚合 ============ */

/** 构建趋势序列：按天（最近 N 天补零）或按月（全部数据） */
function buildTrend(tasks, range) {
  const daily = {};
  tasks.forEach(r => {
    const d = String(r.entry_date || '').slice(0, 10);
    const b = daily[d] = daily[d] || { n: 0, h: 0 };
    b.n++;
    if (r.hours != null) b.h += Number(r.hours);
  });

  if (range === RANGE_ALL) {
    const m = {};
    Object.entries(daily).forEach(([d, b]) => {
      const k = d.slice(0, 7);
      const x = m[k] = m[k] || { n: 0, h: 0 };
      x.n += b.n; x.h += b.h;
    });
    const keys = Object.keys(m).sort();
    return {
      labels: keys.map(k => `${Number(k.slice(5))}月`),
      bars: keys.map(k => m[k].n),
      line: keys.map(k => round1(m[k].h)),
    };
  }

  const labels = [], bars = [], line = [];
  for (let i = range - 1; i >= 0; i--) {
    const d = daysAgo(i);
    labels.push(d.slice(5));
    const b = daily[d];
    bars.push(b ? b.n : 0);
    line.push(b ? round1(b.h) : 0);
  }
  return { labels, bars, line };
}

/** 汇总 + 渲染。host 由 admin.js 传入，t 为视图令牌。 */
function buildHtml(data) {
  const { projects, tasks, followups, reviews, range } = data;

  // ── 项目清单型指标（全量） ──
  const doneRe = /完工|结算|已完/;
  const done = projects.filter(p => doneRe.test(p.status || ''));
  const execActive = projects.filter(p => p.stage === 'exec' && !doneRe.test(p.status || ''));
  const preActive = projects.filter(p => p.stage === 'presale' && !doneRe.test(p.status || ''));

  const amt = {
    po: sum(projects, p => p.po_amount),
    tax: sum(projects, p => p.tax_amount),
    out: sum(projects, p => p.outsource_amount),
    signed: sum(projects, p => p.signed_amount),
    valid: sum(projects, p => p.valid_amount),
  };

  // 项目状态分布
  const statusMap = {};
  projects.forEach(p => {
    const s = (p.status || '').trim() || '未标记';
    statusMap[s] = (statusMap[s] || 0) + 1;
  });
  const statusRows = Object.entries(statusMap)
    .map(([k, v], i) => ({ label: k, value: v, color: PALETTE[i % PALETTE.length] }))
    .sort((a, b) => b.value - a.value);

  // 客户项目分布
  const custMap = {};
  projects.forEach(p => {
    const c = (p.customer || '').trim();
    if (c) custMap[c] = (custMap[c] || 0) + 1;
  });
  const custRows = Object.entries(custMap)
    .map(([k, v]) => ({ label: k, value: v }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 8);

  // ── 时间序列指标（随范围） ──
  const totalTasks = tasks.length;
  const totalHours = sum(tasks, r => r.hours);
  const participants = new Set(tasks.map(r => r.user_name)).size;
  const trend = buildTrend(tasks, range);

  // 人员工时
  const personMap = {};
  tasks.forEach(r => {
    const p = personMap[r.user_name] = personMap[r.user_name] || { n: 0, h: 0, days: new Set() };
    p.n++;
    if (r.hours != null) p.h += Number(r.hours);
    p.days.add(String(r.entry_date || '').slice(0, 10));
  });
  const personRows = Object.entries(personMap)
    .map(([name, p]) => ({ label: name, value: round1(p.h), hint: `${p.n} 条 · ${p.days.size} 天` }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 8);

  // 项目工时投入
  const projMap = {};
  tasks.forEach(r => {
    const k = r.project_code || '（未指定）';
    const p = projMap[k] = projMap[k] || { name: r.project_name || '', n: 0, h: 0 };
    p.n++;
    if (r.hours != null) p.h += Number(r.hours);
  });
  const projHourRows = Object.entries(projMap)
    .map(([code, p]) => ({ label: p.name ? `${code} ${p.name}` : code, value: round1(p.h), hint: `${p.n} 条` }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 8);

  // 项目填报条数
  const projCountRows = Object.entries(projMap)
    .map(([code, p]) => ({ label: p.name ? `${code} ${p.name}` : code, value: p.n, hint: `${round1(p.h)} h` }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 8);

  // 满意度
  const scoreCount = [0, 0, 0, 0, 0];
  let scoreSum = 0, scoreN = 0;
  reviews.forEach(r => {
    const s = Number(r.score);
    if (s >= 1 && s <= 5) { scoreCount[s - 1]++; scoreSum += s; scoreN++; }
  });
  const avgScore = scoreN ? round1(scoreSum / scoreN) : 0;
  const scoreRows = [5, 4, 3, 2, 1].map((star, i) => ({
    label: `${star} 星`, value: scoreCount[star - 1], color: star >= 4 ? C.green : star === 3 ? C.amber : C.gray,
  }));

  // 阶段环形图（合并分类：完工 > 执行 > 售前）
  const stageSegs = [
    { label: '已完工 / 已结算', value: done.length, color: C.green },
    { label: '执行中', value: execActive.length, color: C.accent },
    { label: '售前', value: preActive.length, color: C.amber },
  ];

  const rangeLabel = range === RANGE_ALL ? '全部' : `最近 ${range} 天`;
  const hasHours = totalHours > 0;

  const kpis = [
    { b: projects.length, s: `执行 ${execActive.length} · 售前 ${preActive.length}` },
    { b: done.length, s: '已完工 / 已结算' },
    { b: totalTasks, s: `填报条数 · ${rangeLabel}` },
    { b: totalHours ? fmtH(totalHours) : '—', s: `工时合计 · ${rangeLabel}` },
    { b: participants, s: `参与人数 · ${rangeLabel}` },
    { b: followups.length, s: `客户跟进 · ${rangeLabel}` },
    { b: reviews.length, s: `完工回访 · ${rangeLabel}` },
    { b: scoreN ? avgScore.toFixed(1) + ' ★' : '—', s: `平均满意度 · ${scoreN} 条评分` },
  ];

  return `
    <div class="an-stats">
      ${kpis.map(k => `<div class="an-stat"><b>${esc(k.b)}</b><span>${esc(k.s)}</span></div>`).join('')}
    </div>

    <div class="an-grid">
      <div class="an-card wide">
        <div class="an-card-head">
          <span class="an-card-title">填报趋势</span>
          ${trendLegend()}
        </div>
        <div class="an-card-body">${trendSvg(trend)}</div>
      </div>

      <div class="an-card">
        <div class="an-card-head"><span class="an-card-title">项目阶段分布</span></div>
        <div class="an-card-body an-donut-wrap">
          ${donutSvg(stageSegs, '个项目')}
          <div class="an-legend">${legendHtml(stageSegs)}</div>
        </div>
      </div>

      <div class="an-card">
        <div class="an-card-head"><span class="an-card-title">人员工时排行</span></div>
        <div class="an-card-body">
          ${hasHours ? hBarList(personRows, fmtH)
            : '<div class="an-empty">暂无工时数据 —— 让成员在「每日任务」里补填工时</div>'}
        </div>
      </div>

      <div class="an-card">
        <div class="an-card-head"><span class="an-card-title">项目工时投入 TOP8</span></div>
        <div class="an-card-body">
          ${hasHours ? hBarList(projHourRows, fmtH)
            : '<div class="an-empty">暂无工时数据</div>'}
        </div>
      </div>

      <div class="an-card">
        <div class="an-card-head"><span class="an-card-title">项目填报条数 TOP8</span></div>
        <div class="an-card-body">${hBarList(projCountRows, v => `${v} 条`)}</div>
      </div>

      <div class="an-card">
        <div class="an-card-head"><span class="an-card-title">项目金额概览（全量）</span></div>
        <div class="an-card-body">${hBarList([
          { label: 'PO 金额', value: amt.po, color: C.accent },
          { label: '签单额', value: amt.signed, color: C.teal },
          { label: '有效签单额', value: amt.valid, color: C.green },
          { label: '外包金额', value: amt.out, color: C.violet },
          { label: '税金 6%', value: amt.tax, color: C.amber },
        ], fmtMoney)}</div>
      </div>

      <div class="an-card">
        <div class="an-card-head"><span class="an-card-title">客户项目分布 TOP8</span></div>
        <div class="an-card-body">${hBarList(custRows, v => `${v} 个`)}</div>
      </div>

      <div class="an-card">
        <div class="an-card-head"><span class="an-card-title">满意度分布</span></div>
        <div class="an-card-body">${hBarList(scoreRows, v => `${v} 条`)}</div>
      </div>

      <div class="an-card">
        <div class="an-card-head"><span class="an-card-title">项目状态分布</span></div>
        <div class="an-card-body">${hBarList(statusRows, v => `${v} 个`)}</div>
      </div>
    </div>
  `;
}

/* ============ 入口 ============ */

async function load(host, t) {
  const body = host.querySelector('#an-body');
  if (!body) return;
  body.innerHTML = '<div class="rp-loading">加载分析数据…</div>';

  const from = rangeDays === RANGE_ALL ? '1970-01-01' : daysAgo(rangeDays - 1);
  const to = today();

  let projects, tasks, followups, reviews;
  try {
    [projects, tasks, followups, reviews] = await Promise.all([
      fetchProjectsFull(),
      fetchTasksInRange(from, to, 5000),
      fetchFollowupsInRange(from, to, 3000),
      fetchReviewsInRange(from, to, 3000),
    ]);
  } catch (e) {
    if (staleView(t)) return;
    body.innerHTML = `<div class="rp-error">读取失败：${esc(e.message)}</div>`;
    return;
  }
  if (staleView(t)) return;   // 等待期间切走了 → 丢弃

  body.innerHTML = buildHtml({
    projects: projects || [],
    tasks: tasks || [],
    followups: followups || [],
    reviews: reviews || [],
    range: rangeDays,
  });
}

/**
 * 渲染「数据分析」子页。admin.js 的 renderSub 已 beginView() 并传入令牌 t，
 * 这里在每次 await 后按 t 校验过期，避免切页后旧请求盖屏。
 */
export async function renderAnalytics(host, t) {
  host.innerHTML = `
    <div class="an-bar">
      <select id="an-range" class="rp-select an-range" title="时间范围：只影响填报 / 跟进 / 回访等时间序列指标">
        ${RANGE_OPTS.map(([v, label]) =>
          `<option value="${v}"${v === rangeDays ? ' selected' : ''}>${label}</option>`).join('')}
      </select>
      <span class="an-bar-hint">金额 / 阶段 / 客户分布为全量统计</span>
    </div>
    <div id="an-body"></div>
  `;

  const sel = host.querySelector('#an-range');
  if (sel) {
    sel.addEventListener('change', () => {
      rangeDays = Number(sel.value);
      load(host, t);   // 复用同一令牌：期间无其它视图开始即有效
    });
  }

  await load(host, t);
}
