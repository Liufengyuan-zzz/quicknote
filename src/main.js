let allNotes = {};
let selectedDate = todayStr();
let isPinned = false;

const noteInput = document.getElementById("note-input");
const addBtn = document.getElementById("add-btn");
const noteList = document.getElementById("note-list");
const noteCount = document.getElementById("note-count");
const clearDoneBtn = document.getElementById("clear-done-btn");
const pinBtn = document.getElementById("pin-btn");
const todayBtn = document.getElementById("today-btn");
const heatmapBoard = document.getElementById("heatmap-board");
const heatmapYearTitle = document.getElementById("heatmap-year-title");
const heatmapHint = document.getElementById("heatmap-hint");
const selectedDateLabel = document.getElementById("selected-date-label");
const heatmapDayStats = document.getElementById("heatmap-day-stats");
const dateJumpInput = document.getElementById("date-jump");

function dateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function todayStr() { return dateStr(new Date()); }
function formatDate(str) {
  const d = new Date(str + "T00:00:00");
  const days = ["周日","周一","周二","周三","周四","周五","周六"];
  return `${d.getMonth()+1}月${d.getDate()}日 ${days[d.getDay()]}`;
}
function getCurrentNotes() { return allNotes[selectedDate] || []; }
function setCurrentNotes(notes) {
  if (notes.length === 0) delete allNotes[selectedDate];
  else allNotes[selectedDate] = notes;
}

async function isTauri() { return window.__TAURI_INTERNALS__ !== undefined; }

async function loadNotes() {
  let fromStorage = null;
  try { fromStorage = localStorage.getItem("quicknote_data"); } catch {}
  let fromFile = null;
  try {
    if (await isTauri()) {
      const { invoke } = await import("@tauri-apps/api/core");
      fromFile = await invoke("load_notes");
    }
  } catch { /* IPC 不可用时忽略 */ }
  const source = fromStorage || fromFile || null;
  try { allNotes = source ? JSON.parse(source) : {}; } catch { allNotes = {}; }
  if (!allNotes[todayStr()]) allNotes[todayStr()] = [];
  selectedDate = todayStr();
}

async function saveNotes() {
  const json = JSON.stringify(allNotes);
  // localStorage 兜底：即使 IPC 不可用也能持久化，保证关闭重开不丢
  try { localStorage.setItem("quicknote_data", json); } catch {}
  // 桌面端额外镜像到文件，便于备份（IPC 可用时）
  try {
    if (await isTauri()) {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("save_notes", { content: json });
    }
  } catch { /* IPC 不可用时忽略 */ }
}

const WEEKDAY_LABELS = ["日", "一", "二", "三", "四", "五", "六"];

function parseDateStr(str) {
  const [y, m, d] = str.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function alignToSunday(d) {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  while (out.getDay() !== 0) out.setDate(out.getDate() - 1);
  return out;
}

function alignToSaturday(d) {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  while (out.getDay() !== 6) out.setDate(out.getDate() + 1);
  return out;
}

/** 热力图仅展示当年 1–12 月（周视图对齐到完整周） */
function getHeatmapYearRange(today) {
  const year = today.getFullYear();
  const jan1 = new Date(year, 0, 1);
  const dec31 = new Date(year, 11, 31);
  return {
    year,
    start: alignToSunday(jan1),
    end: alignToSaturday(dec31),
    jan1,
    dec31,
  };
}

function heatmapLevelByCount(count) {
  if (count <= 0) return "level-0";
  if (count <= 2) return "level-1";
  if (count <= 5) return "level-2";
  if (count <= 9) return "level-3";
  return "level-4";
}

/* ============ 中国节假日（2026，来源：国务院办公厅通知） ============ */
// 调休补班日（落在周末、需上班）→ 不算休息日
const MAKEUP_WORKDAYS = new Set([
  "2026-01-04", "2026-02-14", "2026-02-28",
  "2026-05-09", "2026-09-20", "2026-10-10",
]);
// 法定假日区间：[名称, 开始, 结束]
const HOLIDAY_RANGES = [
  ["元旦", "2026-01-01", "2026-01-03"],
  ["春节", "2026-02-15", "2026-02-23"],
  ["清明节", "2026-04-04", "2026-04-06"],
  ["劳动节", "2026-05-01", "2026-05-05"],
  ["端午节", "2026-06-19", "2026-06-21"],
  ["中秋节", "2026-09-25", "2026-09-27"],
  ["国庆节", "2026-10-01", "2026-10-07"],
];
// 展开成 { "2026-01-01": "元旦", ... }
const HOLIDAYS = {};
for (const [name, s, e] of HOLIDAY_RANGES) {
  for (let d = parseDateStr(s); d <= parseDateStr(e); d.setDate(d.getDate() + 1)) {
    HOLIDAYS[dateStr(d)] = name;
  }
}

/** 某天的休息属性：{ rest: 是否休息, holiday: 法定假日名或 null } */
function restKind(ds, d) {
  if (MAKEUP_WORKDAYS.has(ds)) return { rest: false, holiday: null }; // 调休补班 → 上班
  if (HOLIDAYS[ds]) return { rest: true, holiday: HOLIDAYS[ds] };     // 法定假日 → 绿点
  const wd = d.getDay();
  if (wd === 0 || wd === 6) return { rest: true, holiday: null };     // 普通周末 → 蓝点
  return { rest: false, holiday: null };
}

function weekHasFirstOfMonth(dates, year) {
  return dates.some(d => d.getFullYear() === year && d.getDate() === 1);
}

function renderHeatmap() {
  heatmapBoard.innerHTML = "";
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayString = todayStr();
  const { year, start, end } = getHeatmapYearRange(today);

  if (heatmapYearTitle) heatmapYearTitle.textContent = `${year} 年每日记录`;
  if (heatmapHint) {
    heatmapHint.textContent = `显示 ${year} 年 1–12 月，可左右滑动；更早日期请用「跳转日期」`;
  }

  const monthNames = ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"];
  const weeks = [];
  const iter = new Date(start);

  while (iter <= end) {
    const dates = [];
    const cells = [];
    for (let day = 0; day < 7; day++) {
      if (iter > end) break;
      const d = new Date(iter);
      dates.push(d);
      const ds = dateStr(d);
      const inYear = d.getFullYear() === year;
      const dayNotes = inYear ? (allNotes[ds] || []) : [];
      const count = dayNotes.length;
      const doneCount = dayNotes.filter(n => n.done).length;
      const isAfterToday = d > today;
      const kind = restKind(ds, d);
      cells.push({
        ds,
        day: d.getDate(),
        count,
        doneCount,
        inYear,
        isAfterToday,
        isToday: inYear && ds === todayString,
        isSelected: inYear && ds === selectedDate,
        rest: inYear && kind.rest,
        holiday: inYear ? kind.holiday : null,
      });
      iter.setDate(iter.getDate() + 1);
    }
    while (cells.length < 7) {
      cells.push({ ds: "", count: 0, doneCount: 0, inYear: false, isAfterToday: true, isToday: false, isSelected: false, pad: true });
    }
    if (dates.length) weeks.push({ dates, cells });
  }

  const weekCount = weeks.length;
  heatmapBoard.style.setProperty("--week-cols", String(weekCount));

  const frag = document.createDocumentFragment();
  const corner = document.createElement("div");
  corner.className = "heatmap-corner";
  frag.appendChild(corner);

  const monthStarts = [0];
  for (let i = 1; i < weeks.length; i++) {
    if (weekHasFirstOfMonth(weeks[i].dates, year)) monthStarts.push(i);
  }

  for (let s = 0; s < monthStarts.length; s++) {
    const from = monthStarts[s];
    const to = s + 1 < monthStarts.length ? monthStarts[s + 1] : weeks.length;
    const span = to - from;
    const labelDate = weeks[from].dates.find(d => d.getFullYear() === year && d.getDate() === 1)
      || weeks[from].dates.find(d => d.getFullYear() === year);
    if (!labelDate) continue;
    const monthEl = document.createElement("div");
    monthEl.className = "heatmap-month-cell";
    monthEl.textContent = monthNames[labelDate.getMonth()];
    monthEl.style.gridRow = "1";
    monthEl.style.gridColumn = `${from + 2} / span ${span}`;
    frag.appendChild(monthEl);
  }

  WEEKDAY_LABELS.forEach((label, row) => {
    const dayLabel = document.createElement("div");
    dayLabel.className = "heatmap-day-label";
    dayLabel.textContent = label;
    dayLabel.style.gridRow = String(row + 2);
    dayLabel.style.gridColumn = "1";
    frag.appendChild(dayLabel);
  });

  weeks.forEach((week, col) => {
    week.cells.forEach((cell, row) => {
      const el = document.createElement("div");
      el.className = "heatmap-cell";
      el.dataset.date = cell.ds;
      el.style.gridRow = String(row + 2);
      el.style.gridColumn = String(col + 2);
      if (!cell.inYear || cell.pad) el.classList.add("future", "level-0");
      else {
        if (cell.isAfterToday) el.classList.add("level-0", "upcoming");
        else el.classList.add(heatmapLevelByCount(cell.count));
        el.textContent = String(cell.day);
      }
      if (cell.isToday) el.classList.add("today");
      if (cell.isSelected) el.classList.add("selected");
      if (cell.holiday) el.classList.add("rest-holiday");
      else if (cell.rest) el.classList.add("rest-weekend");
      else if (cell.inYear && MAKEUP_WORKDAYS.has(cell.ds)) el.classList.add("makeup");
      if (cell.inYear && !cell.isAfterToday && !cell.pad) {
        const kindText = cell.holiday ? `\n${cell.holiday}（法定假日）`
          : MAKEUP_WORKDAYS.has(cell.ds) ? "\n调休上班"
          : cell.rest ? "\n周末" : "";
        el.title = cell.count === 0
          ? `${formatDate(cell.ds)}${kindText}\n无记录`
          : `${formatDate(cell.ds)}${kindText}\n${cell.count} 条记录${cell.doneCount > 0 ? `，${cell.doneCount} 条已完成` : ""}`;
        el.dataset.clickable = "1";
      }
      frag.appendChild(el);
    });
  });

  heatmapBoard.replaceChildren(frag);
}

function addNote() {
  const text = noteInput.value.trim();
  if (!text) return;
  const notes = getCurrentNotes();
  notes.unshift({ id: Date.now(), text, done: false });
  setCurrentNotes(notes);
  noteInput.value = "";
  saveNotes(); renderAll(); noteInput.focus();
}

function toggleNote(id) {
  const notes = getCurrentNotes();
  const note = notes.find(n => n.id === id);
  if (note) note.done = !note.done;
  setCurrentNotes(notes); saveNotes(); renderAll();
}

function deleteNote(id) {
  let notes = getCurrentNotes();
  notes = notes.filter(n => n.id !== id);
  setCurrentNotes(notes); saveNotes(); renderAll();
}

function clearDone() {
  let notes = getCurrentNotes();
  notes = notes.filter(n => !n.done);
  setCurrentNotes(notes); saveNotes(); renderAll();
}

function goToToday() { selectedDate = todayStr(); renderAll({ scroll: true }); }

function renderNotes() {
  noteList.innerHTML = "";
  const notes = getCurrentNotes();
  const isToday = selectedDate === todayStr();
  const isPast = selectedDate < todayStr();
  if (isPast) {
    const b = document.createElement("div");
    b.className = "past-day-banner";
    const dayKind = HOLIDAYS[selectedDate] ? `（${HOLIDAYS[selectedDate]}）`
      : MAKEUP_WORKDAYS.has(selectedDate) ? "（调休上班）" : "";
    b.textContent = `📅 ${formatDate(selectedDate)}${dayKind} 的历史记录`;
    noteList.appendChild(b);
  }
  if (notes.length === 0) {
    const e = document.createElement("div");
    e.className = "empty-state";
    e.textContent = isToday ? "暂无记录，开始添加吧 ✍️" : "当天没有记录";
    noteList.appendChild(e);
  } else {
    notes.forEach(note => {
      const li = document.createElement("li");
      if (note.done) li.classList.add("done");
      const cb = document.createElement("div");
      cb.className = "note-checkbox";
      cb.addEventListener("click", () => toggleNote(note.id));
      const sp = document.createElement("span");
      sp.className = "note-text";
      sp.textContent = note.text;
      sp.addEventListener("dblclick", () => editNote(note.id, sp));
      const db = document.createElement("button");
      db.className = "note-delete";
      db.textContent = "✕";
      db.addEventListener("click", () => deleteNote(note.id));
      li.append(cb, sp, db);
      noteList.appendChild(li);
    });
  }
  const dc = notes.filter(n => n.done).length;
  noteCount.textContent = `${notes.length} 条记录` + (dc > 0 ? `，${dc} 已完成` : "");
}

function editNote(id, span) {
  const notes = getCurrentNotes();
  const note = notes.find(n => n.id === id);
  if (!note) return;
  const input = document.createElement("input");
  input.type = "text"; input.value = note.text;
  input.style.cssText = "flex:1;padding:4px 10px;border:1.5px solid var(--accent);border-radius:6px;background:var(--card);color:var(--text);font-size:0.88rem;outline:none;font-family:inherit;";
  span.replaceWith(input); input.focus(); input.select();
  const finish = () => {
    const t = input.value.trim();
    if (t && t !== note.text) { note.text = t; setCurrentNotes(notes); saveNotes(); }
    renderAll();
  };
  input.addEventListener("blur", finish);
  input.addEventListener("keydown", e => { if (e.key==="Enter") finish(); if (e.key==="Escape") renderAll(); });
}

function dayKindLabel(ds) {
  if (HOLIDAYS[ds]) return HOLIDAYS[ds];
  if (MAKEUP_WORKDAYS.has(ds)) return "调休上班";
  return "";
}

function updateDateLabel() {
  const t = todayStr();
  const notes = allNotes[selectedDate] || [];
  const done = notes.filter(n => n.done).length;
  selectedDateLabel.textContent = selectedDate === t ? `今天 · ${formatDate(t)}` : formatDate(selectedDate);
  const kind = dayKindLabel(selectedDate);
  const kindSuffix = kind ? ` · ${kind}` : "";
  if (notes.length === 0) {
    heatmapDayStats.textContent = `当天暂无记录${kindSuffix}`;
    heatmapDayStats.classList.add("empty");
  } else {
    heatmapDayStats.textContent = `${notes.length} 条记录${done > 0 ? ` · ${done} 已完成` : ""}${kindSuffix}`;
    heatmapDayStats.classList.remove("empty");
  }
  todayBtn.classList.toggle("active", selectedDate === t);
  if (dateJumpInput) {
    dateJumpInput.max = t;
    if (selectedDate <= t) dateJumpInput.value = selectedDate;
  }
}

function renderAll(opts = {}) {
  const { scroll = false, heatmap = true } = opts;
  if (heatmap) renderHeatmap();
  renderNotes();
  updateDateLabel();
  if (!scroll) return;
  requestAnimationFrame(() => {
    const inYear = selectedDate.startsWith(String(new Date().getFullYear()));
    const target = (inYear && heatmapBoard.querySelector(".heatmap-cell.selected"))
      || heatmapBoard.querySelector(".heatmap-cell.today");
    if (target) target.scrollIntoView({ behavior: "auto", inline: "center", block: "nearest" });
  });
}

function revealWindow() {
  // 首屏 DOM 已渲染完成（等两帧确保浏览器真的画出来了），
  // 再通知 Rust 显示窗口，避免出现"窗口先出现、内容后画出"的白屏。
  if (!window.__TAURI_INTERNALS__) return;
  requestAnimationFrame(() => {
    requestAnimationFrame(async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("frontend_ready");
      } catch { /* ignore */ }
    });
  });
}

async function boot() {
  if (!allNotes[todayStr()]) allNotes[todayStr()] = [];
  // 先替换「正在加载」，立刻可交互
  updateDateLabel();
  renderNotes();
  // 兜底亮窗（若 Rust 侧已 show 则无影响）
  revealWindow();

  await loadNotes();
  renderNotes();
  updateDateLabel();
  requestAnimationFrame(() => {
    renderHeatmap();
    requestAnimationFrame(() => {
      const target = heatmapBoard.querySelector(".heatmap-cell.today");
      if (target) target.scrollIntoView({ behavior: "auto", inline: "center", block: "nearest" });
    });
  });

  // 登录已通过，此时才恢复上次所在的选项卡 —— 填报面板必须在已登录后才挂载，
  // 否则它会在未登录状态下读到「被 RLS 过滤成空」的人员/项目（详见 restoreAppTab 注释）。
  restoreAppTab();
}

function onDateJumpChange() {
  const val = dateJumpInput?.value;
  if (!val || val > todayStr()) return;
  selectedDate = val;
  renderAll({ scroll: true });
}

async function togglePin() {
  isPinned = !isPinned;
  pinBtn.classList.toggle("pinned", isPinned);
  if (window.__TAURI_INTERNALS__) {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().setAlwaysOnTop(isPinned);
    } catch (e) { console.error("Pin failed:", e); }
  }
}

heatmapBoard.addEventListener("click", (e) => {
  const cell = e.target.closest(".heatmap-cell[data-clickable='1']");
  if (!cell) return;
  e.stopPropagation();
  selectedDate = cell.dataset.date;
  renderAll({ scroll: true });
});

addBtn.addEventListener("click", addNote);
noteInput.addEventListener("keydown", e => { if (e.key==="Enter") addNote(); });
clearDoneBtn.addEventListener("click", clearDone);
pinBtn.addEventListener("click", togglePin);
todayBtn.addEventListener("click", goToToday);
if (dateJumpInput) dateJumpInput.addEventListener("change", onDateJumpChange);

/* ================================================================
   启动流程：先过登录门禁，再进入主界面
   ----------------------------------------------------------------
   未登录时停在 auth.js 渲染的登录界面，登录成功后才继续 boot()。
   注意窗口是 visible:false、由前端 invoke('frontend_ready') 唤起的，
   所以门禁阶段也必须先把窗口显示出来 —— 否则用户看不到登录框，
   窗口永远不出现，表现为「软件打不开」。
   ================================================================ */
(async function start() {
  revealWindow();

  let user = null;
  try {
    const { ensureSignedIn } = await import('./auth.js');
    user = await ensureSignedIn();
  } catch (e) {
    console.error('登录模块加载失败：', e);
    const gate = document.getElementById('auth-gate');
    if (gate) {
      gate.hidden = false;
      document.body.classList.add('auth-locked');
      const msg = String((e && e.message) || e).replace(/[<>&"]/g, '');
      gate.innerHTML = `<div class="auth-card">
        <h2>无法启动</h2>
        <p class="auth-sub">${msg}</p>
        <button type="button" class="auth-primary">重新加载</button>
      </div>`;
      const btn = gate.querySelector('button');
      if (btn) btn.addEventListener('click', () => location.reload());
    }
    return;
  }

  await boot();

  // 底部「退出」：换人使用同一台机器时用得上（会清掉本机缓存）
  const signOutBtn = document.getElementById('sign-out-btn');
  if (signOutBtn) {
    if (user && user.email) signOutBtn.title = `退出登录（${user.email}）`;
    signOutBtn.addEventListener('click', async () => {
      if (!confirm('退出登录？本机缓存的填报数据会被清除。')) return;
      const { signOut } = await import('./auth.js');
      await signOut();
    });
  }

  // 应用内更新：启动后延迟静默检查，有新版本在顶部显示提示条（非 Tauri 环境自动跳过）
  import('./updater.js').then(m => m.initUpdater()).catch(() => { /* 更新检查失败不影响主功能 */ });
})();

/* ================================================================
   主选项卡切换：便签 / 项目填报
   ================================================================ */
const APP_TAB_KEY = "quicknote_app_tab";
let reportMounted = false;

async function switchAppTab(name) {
  document.body.classList.toggle("tab-report", name === "report");
  document.querySelectorAll(".app-tab").forEach(b =>
    b.classList.toggle("active", b.dataset.appTab === name));
  try { localStorage.setItem(APP_TAB_KEY, name); } catch { /* ignore */ }

  if (name === "report" && !reportMounted) {
    reportMounted = true;
    try {
      const { mountReport } = await import("./report.js");
      mountReport();
    } catch (e) {
      const host = document.getElementById("report-panel");
      if (host) host.innerHTML =
        `<div class="rp-error">填报模块加载失败：${e.message}</div>`;
    }
  }
}

document.querySelectorAll(".app-tab").forEach(b =>
  b.addEventListener("click", () => switchAppTab(b.dataset.appTab)));

// 恢复上次所在选项卡
// ★ 只能在登录门禁通过之后调用（见 boot()）：填报面板一挂载就会去云端读人员/项目，
//   而服务端 RLS 会把**未登录**的请求过滤成 0 行（200 空数组）——不是报错，是静默的空结果。
//   于是选人下拉里只剩「管理员」，而且 reportMounted 已置 true，登录成功后也不会重挂，
//   整个会话都恢复不过来（表现为「第一次登录选不了身份」）。
function restoreAppTab() {
  let saved = "note";
  try { saved = localStorage.getItem(APP_TAB_KEY) || "note"; } catch { /* ignore */ }
  if (saved === "report") switchAppTab("report");
}

/* ================================================================
   关闭行为：点 X 后由 Rust 侧拦截并隐藏到系统托盘（不再销毁窗口）。
   数据在每次增删改时已实时写入 localStorage，无需额外退出前保存。
   ================================================================ */
