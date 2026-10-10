/**
 * cloud.js — 项目填报云数据池客户端
 *
 * 对接 WorkBuddy Cloud Service（官方 SDK @tencent-ai/workbuddy-cloud-sdk）。
 * 环境：applicationId wbapp_jeldkgNGPBb4UQI7K3ng8J
 *
 * ★ 传输层选择（关键）：
 * - Tauri 桌面端：打包后 WebView 的 origin 是 http://tauri.localhost，
 *   云服务端 origin 白名单不包含它，WebView 内直接 fetch 会被 403 拒绝。
 *   因此用 @tauri-apps/plugin-http 的 fetch（由 Rust reqwest 发出，无 CORS），
 *   并把请求的 Origin 头改写成白名单内的来源（见 CLOUD_ORIGIN）。
 * - 纯浏览器（vite dev 直接开 / jsdom 测试）：用全局 fetch 即可
 *   （dev server 的 origin http://localhost:1420 在服务端白名单里）。
 *
 * SDK 支持 createWorkBuddyCloud({ fetch }) 注入自定义传输，正好接上。
 *
 * ★ 鉴权：所有数据访问都要求已登录（见 auth.js）。服务端 RLS 只放行
 *   「已登录 + 邮箱域名 = @shmatching.com」的请求，客户端拿不到绕过手段。
 */

import { createWorkBuddyCloud } from '@tencent-ai/workbuddy-cloud-sdk';

/**
 * 云端连接参数 —— 构建时注入，源码里不出现。
 *
 * 取值来源（vite 在构建时静态内联）：
 *   本地开发 → 项目根目录 .env.local（已 gitignore）
 *   CI 构建  → GitHub Secrets（VITE_CLOUD_ENDPOINT / VITE_CLOUD_KEY）
 * 模板见 .env.example。
 *
 * 说明：vite 的环境变量是**构建时内联**，因此打包产物里仍有这两个值 ——
 * 这是「前端直连数据库」架构的必然结果。数据安全靠服务端 RLS 策略
 * （必须登录 + 邮箱域名匹配），不靠隐藏这个标识符。
 */
const env = import.meta.env || {};

export const ENDPOINT = String(env.VITE_CLOUD_ENDPOINT || '').trim();
export const PUBLISHABLE_KEY = String(env.VITE_CLOUD_KEY || '').trim();

/**
 * 请求 Origin —— 云服务端按它判定「客户端身份」，并写进会话（access_token 的 azp claim）。
 *
 * 实测三种情形（同样的发码 + 提交验证码，只改 Origin）：
 *   不带 Origin             → 发码能过，换会话报 401「issued for another client」
 *   http://tauri.localhost  → 403「origin is not allowed for this client」（WebView 原生来源）
 *   endpoint 的来源         → 200，正常签发会话
 *
 * 白名单实测放行：endpoint 域名（https）、http(s)://localhost:1420、http://localhost:3000；
 * 拒绝：tauri.localhost（http/https）、tauri.app、以及 endpoint 域名的 http 版本。
 *
 * 所以取 endpoint 自身的 origin —— 不写死域名，也避免它出现在源码里；
 * 若将来 endpoint 与可访问域名不再一致，可用 VITE_CLOUD_ORIGIN 覆盖。
 */
function cloudOrigin() {
  if (env.VITE_CLOUD_ORIGIN) return String(env.VITE_CLOUD_ORIGIN).trim();
  try { return new URL(ENDPOINT).origin; } catch { return ''; }
}

/** 配置缺失时给人话提示，而不是让 SDK 抛一个看不懂的错 */
function assertConfigured() {
  if (!ENDPOINT || !PUBLISHABLE_KEY) {
    throw new Error(
      '云端配置缺失：未设置 VITE_CLOUD_ENDPOINT / VITE_CLOUD_KEY。' +
      '本地开发请在项目根目录创建 .env.local（可参考 .env.example）。'
    );
  }
}

/* ============ 懒加载单例 ============ */

let cloudPromise = null;

/**
 * 包一层 Tauri fetch：把 Origin 改写成云服务端白名单内的来源。
 *
 * 为什么必须这么做：
 * tauri-plugin-http 的 Rust 侧有一条硬逻辑 ——「ensure we have an Origin header set」，
 * 它会把 WebView 的 origin（生产环境是 http://tauri.localhost）塞进每个请求。
 * 云服务端的 origin 白名单不含它，于是回 403 access_denied 且响应体为空。
 *
 * 但「直接删掉 Origin」同样不行：云服务端按 Origin 判定客户端身份、并把它写进会话
 * （access_token 的 azp claim）。没有 Origin 时，发码能通过，但换会话这一步会被
 * 401 invalid_grant 拒绝 ——「the session is invalid, expired or issued for another client」。
 * 所以正确做法是**改写**成白名单内的来源，而不是删掉。
 *
 * 插件侧留了官方后门（commands.rs L290-309）：启用 unsafe-headers feature 后，
 * 请求只要已带 Origin 就不再覆盖（Cargo.toml 已开该 feature），
 * 因此这里设置的值会原样发出。
 */
function wrapTauriFetch(tauriFetch) {
  return async function fetchWithCloudOrigin(input, init = {}) {
    const headers = new Headers(init.headers || (input?.headers ?? undefined));
    headers.set('Origin', cloudOrigin()); // 触发插件保留该值（空串则退化为删除）
    try {
      return await tauriFetch(input, { ...init, headers });
    } catch (e) {
      // tauri-plugin-http 的 Rust 侧 reject 的是**字符串**，不是 Error 实例。
      // 云 SDK 用 `${err?.name ?? "FetchError"}: ${err?.message}` 拼报错文案——
      // 字符串的 name / message 都是 undefined，界面上就只剩一句毫无信息量的
      // 「FetchError: undefined」，真实原因（DNS / TLS / scope 拒绝…）全被吞掉。
      // 这里统一包成 Error 把真实原因带出去。
      if (e instanceof Error) throw e;
      const detail = typeof e === 'string' ? e : safeStringify(e);
      const wrapped = new Error(`tauri-http: ${detail || '(未知传输错误)'}`);
      wrapped.cause = e;
      throw wrapped;
    }
  };
}

function safeStringify(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

async function resolveFetch() {
  // Tauri 环境：走 Rust 侧 fetch，绕开 WebView 的 CORS 限制
  if (typeof window !== 'undefined' && window.__TAURI_INTERNALS__) {
    try {
      const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http');
      return wrapTauriFetch(tauriFetch);
    } catch (e) {
      console.warn('plugin-http 加载失败，回退到全局 fetch：', e);
    }
  }
  return globalThis.fetch.bind(globalThis);
}

export function getCloud() {
  if (!cloudPromise) {
    cloudPromise = Promise.resolve()
      .then(() => { assertConfigured(); })   // 放进 promise 链，失败也走 catch 且不缓存
      .then(() => resolveFetch())
      .then(fetchImpl =>
        createWorkBuddyCloud({
          endpoint: ENDPOINT,
          publishableKey: PUBLISHABLE_KEY,
          fetch: fetchImpl,
        })
      )
      .catch(e => {
        cloudPromise = null;  // 失败不缓存，下次重试（比如用户点「重试」按钮）
        throw e;
      });
  }
  return cloudPromise;
}

/** 把 SDK 返回包成 throw-on-error。
 *  SDK 实际返回 { success, error, data, count, status, statusText } —— 与 supabase-js 的
 *  { data, error } 是超集，这里两种形状都兼容。
 *  诊断友好：把 HTTP 状态码一并带出来，避免只看到干巴巴的「请求失败」。 */
async function unwrap(promise) {
  const res = await promise;
  const { data, error, status, statusText } = res || {};
  if (error) {
    const code = error.code ? `(${error.code})` : '';
    const http = status ? ` [HTTP ${status}${statusText ? ' ' + statusText : ''}]` : '';
    throw new Error(`${error.message || '请求失败'}${code}${http}`);
  }
  return data;
}

/* ============ 轻量数据缓存 ============
 *
 * 为什么需要：单次云端请求的往返在 0.3～1.3 秒量级，而每个页面切换都会重新发
 * 1～3 个请求。用户感知到的「慢」几乎全来自重复的网络往返，与数据量无关。
 *
 * 策略（对调用方完全透明，读接口内部生效）：
 *   1. 90 秒内命中缓存 → 直接返回，不发请求（切页基本都落在这一档）
 *   2. 超过 90 秒 → **先返回旧数据让页面立刻渲染**，同时后台拉最新，下次切页即为新数据
 *   3. 同一 key 的并发请求合并成一次（多个视图同时要 projects 时只发一次）
 *   4. 任何写操作后按前缀清缓存 → 自己改的数据立刻可见，不会读到旧值
 *
 * 外加「离线兜底」：人员 / 项目 / 客户三张变化很慢的表会落到 localStorage，
 * 冷启动时先秒显上次的数据（视为过期），后台再刷新 —— 打开软件不再白等。
 *
 * 取舍：别人在另一台设备上的修改，最坏情况要等下一次切页刷新才出现
 * （写在 90 秒之外的下一次读取，或本机任何一次写操作后立即失效）。
 */

const CACHE = new Map();          // key → { at, data, inflight }
const CACHE_TTL = 90_000;         // 90 秒

/** 允许落盘的 key 前缀：只放变化慢、体量小的表；task_entries 类记录不落盘 */
const PERSIST_PREFIXES = ['staff:', 'projects:', 'customers:'];
const LS_CACHE = 'qn_cache_v1';

function isPersistable(key) {
  return PERSIST_PREFIXES.some(p => key.startsWith(p));
}

function savePersist() {
  try {
    const out = {};
    for (const [k, v] of CACHE) {
      if (isPersistable(k) && v.data !== undefined) out[k] = v.data;
    }
    localStorage.setItem(LS_CACHE, JSON.stringify(out));
  } catch { /* 空间不足 / 不可用：放弃落盘，不影响功能 */ }
}

/** 冷启动把上次的数据灌回缓存，at:0 表示「视为过期」——先秒显，随后后台刷新 */
function hydratePersist() {
  try {
    const raw = localStorage.getItem(LS_CACHE);
    if (!raw) return;
    const obj = JSON.parse(raw);
    Object.keys(obj).forEach(k => {
      if (isPersistable(k)) CACHE.set(k, { at: 0, data: obj[k] });
    });
  } catch { /* 脏数据直接忽略 */ }
}
hydratePersist();

/** 真正发请求，并把结果写回缓存；同 key 并发时复用同一个 promise */
function load(key, loader) {
  const cur = CACHE.get(key);
  if (cur && cur.inflight) return cur.inflight;

  const p = Promise.resolve()
    .then(loader)
    .then(data => {
      CACHE.set(key, { at: Date.now(), data });
      if (isPersistable(key)) savePersist();
      return data;
    })
    .catch(e => {
      // 失败：有旧数据就留着继续用（页面别变空），否则清掉让下次重试
      const old = CACHE.get(key);
      if (old && old.data !== undefined) CACHE.set(key, { at: old.at, data: old.data });
      else CACHE.delete(key);
      throw e;
    });

  CACHE.set(key, { at: cur ? cur.at : 0, data: cur ? cur.data : undefined, inflight: p });
  return p;
}

/**
 * 带缓存的读取。
 * @param {string} key   缓存键
 * @param {Function} loader 真正取数的函数（返回 Promise）
 * @param {number} [ttl] 新鲜期，默认 90 秒
 * @param {boolean} [force] 跳过「先返回旧值再后台刷新」的捷径，等一次真实请求。
 *   调用方拿到的是**本次请求的结果**，而不是可能已经过期的旧值。
 *   用于「上一次读到的是不可信数据（如未登录时被 RLS 过滤成空）」的场景。
 */
export function cachedRead(key, loader, ttl = CACHE_TTL, force = false) {
  const hit = CACHE.get(key);
  if (hit && hit.inflight) return hit.inflight;   // 有在途请求就复用它（force 也一样）
  if (hit && !force) {
    const age = Date.now() - hit.at;
    if (age < ttl) return Promise.resolve(hit.data);
    if (hit.data !== undefined) {
      load(key, loader).catch(() => { /* 后台刷新失败就继续用旧数据 */ });
      return Promise.resolve(hit.data);
    }
  }
  return load(key, loader);
}

/** 同步读缓存（不看新鲜度）；没有则 undefined。给「有就先渲染」这类场景用 */
export function peekCache(key) {
  const hit = CACHE.get(key);
  return hit ? hit.data : undefined;
}

/**
 * 清缓存。写操作后调用，保证自己改的数据立刻可见。
 * @param {string} [prefix] 只清这个前缀；不传清全部
 */
export function clearCache(prefix) {
  if (!prefix) {
    CACHE.clear();
    try { localStorage.removeItem(LS_CACHE); } catch { /* ignore */ }
    return;
  }
  let touchedPersist = false;
  for (const k of [...CACHE.keys()]) {
    if (!k.startsWith(prefix)) continue;
    CACHE.delete(k);
    if (isPersistable(k)) touchedPersist = true;
  }
  if (touchedPersist) savePersist();
}

/**
 * 预热：首屏加载完成后在后台把「接下来大概率要看」的数据拉好，
 * 让第一次切页也是秒开。失败静默，不打扰用户。
 */
export function warmCache() {
  [fetchStaffAll, fetchCustomers, fetchAllProjectTasks].forEach(fn => {
    try { fn().catch(() => {}); } catch { /* ignore */ }
  });
}

/* ============ 人员 ============ */

/** 免填每日任务的人员判定（唯一口径，员工端/管理端共用）。
 *  纯「客户经理」与「管理员」不参与每日项目填报；
 *  复合角色如「客户经理/项目经理」仍要填报（如孔东海、林思宇）。 */
export function isExemptRole(role) {
  return role === '客户经理' || role === '管理员';
}

/** 人员名册：服务端已按 active=true 过滤，故返回里没有 active 字段 */
async function loadStaff() {
  const cloud = await getCloud();
  return unwrap(
    cloud.database
      .from('staff')
      .select('name,role,dept')
      .eq('active', true)
      .order('sort_order', { ascending: true })
  );
}
export function fetchStaff(force = false) { return cachedRead('staff:active', loadStaff, CACHE_TTL, force); }

/** 全员（含未激活），管理员视图用 */
async function loadStaffAll() {
  const cloud = await getCloud();
  return unwrap(
    cloud.database
      .from('staff')
      .select('id,name,role,dept,active,is_admin,sort_order')
      .order('sort_order', { ascending: true })
  );
}
export function fetchStaffAll() { return cachedRead('staff:all', loadStaffAll); }

/* ============ 管理员口令 ============ */

/** 浏览器/WebView 通用 SHA-256（十六进制） */
async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** 校验管理员口令。返回 true/false。口令以 SHA-256 哈希存于 app_config。 */
export async function verifyAdminPassword(pwd) {
  const cloud = await getCloud();
  const rows = await unwrap(
    cloud.database.from('app_config').select('value').eq('key', 'admin_pwd_hash')
  );
  const stored = Array.isArray(rows) && rows[0] ? rows[0].value : null;
  if (!stored) throw new Error('未配置管理员口令（app_config 缺少 admin_pwd_hash）');
  const got = await sha256Hex('qn::' + pwd);
  return got === stored;
}

/* ============ 项目 ============ */

async function loadProjects() {
  const cloud = await getCloud();
  return unwrap(
    cloud.database
      .from('projects')
      .select('id,code,name,customer,project_mgr,status,stage,quote_deadline,progress,note3')
      .eq('archived', false)
      .order('stage', { ascending: true })
      .order('sort_order', { ascending: true })
  );
}
export function fetchProjects(force = false) { return cachedRead('projects:list', loadProjects, CACHE_TTL, force); }

/**
 * 导出专用：拉取项目全字段（含金额、备注、GR、发票等）。
 * 与 fetchProjects() 分开是因为后者只取列表页需要的 9 个字段，
 * 而导出报表需要所有列 —— 复用会导致金额列全空。
 */
async function loadProjectsFull() {
  const cloud = await getCloud();
  return unwrap(
    cloud.database
      .from('projects')
      .select('*')
      .eq('archived', false)
      .order('stage', { ascending: true })
      .order('sort_order', { ascending: true })
  );
}
export function fetchProjectsFull() { return cachedRead('projects:full', loadProjectsFull); }

/**
 * 项目维护专用：拉全字段 + **包含已归档**。
 * 只有「项目维护」子页需要看归档项目（以便恢复），
 * 导出/列表/员工选择器一律走不带 archived 的那两个函数，不显示归档项。
 */
async function loadProjectsAll() {
  const cloud = await getCloud();
  return unwrap(
    cloud.database
      .from('projects')
      .select('*')
      .order('stage', { ascending: true })
      .order('sort_order', { ascending: true })
  );
}
export function fetchProjectsAll() { return cachedRead('projects:all', loadProjectsAll); }

/* ---------- 客户清单 ---------- */

async function loadCustomers() {
  const cloud = await getCloud();
  return unwrap(
    cloud.database.from('customers').select('id,name,contact,sort_order')
      .eq('active', true).order('sort_order', { ascending: true }).order('name', { ascending: true })
  );
}
export function fetchCustomers() { return cachedRead('customers:active', loadCustomers); }

async function loadCustomersAll() {
  const cloud = await getCloud();
  return unwrap(
    cloud.database.from('customers').select('*')
      .order('sort_order', { ascending: true }).order('name', { ascending: true })
  );
}
export function fetchCustomersAll() { return cachedRead('customers:all', loadCustomersAll); }

/** 新增客户。contact 为默认联系人（可空），客户跟进时自动带出 */
export async function addCustomer(name, contact) {
  const cloud = await getCloud();
  const r = await unwrap(
    cloud.database.from('customers').insert({ name, contact: contact || null }).select()
  );
  clearCache('customers:');
  return r;
}

export async function updateCustomer(id, patch) {
  const cloud = await getCloud();
  const r = await unwrap(cloud.database.from('customers').update(patch).eq('id', id).select());
  clearCache('customers:');
  return r;
}

export async function deleteCustomer(id) {
  const cloud = await getCloud();
  const r = await unwrap(cloud.database.from('customers').delete().eq('id', id).select());
  clearCache('customers:');
  return r;
}

/** 物理删除人员（与「停用」不同：记录从 staff 表移除；历史填报记录里保留姓名字符串，不受影响） */
export async function deleteStaff(id) {
  const cloud = await getCloud();
  const r = await unwrap(cloud.database.from('staff').delete().eq('id', id).select());
  clearCache('staff:');
  return r;
}

/** 物理删除项目 */
export async function deleteProject(id) {
  const cloud = await getCloud();
  const r = await unwrap(cloud.database.from('projects').delete().eq('id', id).select());
  clearCache('projects:');
  return r;
}

/** 按项目编号清掉该项目下全部任务（删除项目时的级联清理；历史填报里的任务名是快照，不受影响） */
export async function deleteProjectTasksByCode(code) {
  const cloud = await getCloud();
  const r = await unwrap(cloud.database.from('project_tasks').delete().eq('project_code', code).select());
  clearCache('tasks:');
  return r;
}

/* ============ 项目任务（v1.5.4） ============ */

/** 某个项目下的任务。员工填报用 —— 只取启用中的 */
async function loadProjectTasks(projectCode) {
  const cloud = await getCloud();
  return unwrap(
    cloud.database
      .from('project_tasks')
      .select('id,project_code,name,sort_order,active')
      .eq('project_code', projectCode)
      .eq('active', true)
      .order('sort_order', { ascending: true })
      .order('id', { ascending: true })
      .limit(300)
  );
}
export function fetchProjectTasks(projectCode) {
  return cachedRead(`tasks:${projectCode}`, () => loadProjectTasks(projectCode));
}

/** 全部项目任务（管理端用，含停用项）—— 列表计数 + 任务管理都靠它 */
async function loadAllProjectTasks() {
  const cloud = await getCloud();
  return unwrap(
    cloud.database
      .from('project_tasks')
      .select('id,project_code,name,sort_order,active')
      .order('project_code', { ascending: true })
      .order('sort_order', { ascending: true })
      .order('id', { ascending: true })
      .limit(5000)
  );
}
export function fetchAllProjectTasks() { return cachedRead('tasks:@all', loadAllProjectTasks); }

export async function addProjectTask(t) {
  const cloud = await getCloud();
  const r = await unwrap(
    cloud.database
      .from('project_tasks')
      .insert({
        project_code: t.project_code,
        name: t.name,
        sort_order: t.sort_order ?? 999,
        active: true,
      })
      .select()
  );
  clearCache('tasks:');
  return r;
}

export async function updateProjectTask(id, patch) {
  const cloud = await getCloud();
  const r = await unwrap(cloud.database.from('project_tasks').update(patch).eq('id', id).select());
  clearCache('tasks:');
  return r;
}

export async function deleteProjectTask(id) {
  const cloud = await getCloud();
  const r = await unwrap(cloud.database.from('project_tasks').delete().eq('id', id).select());
  clearCache('tasks:');
  return r;
}

export async function addStaff(s) {
  const cloud = await getCloud();
  const r = await unwrap(cloud.database.from('staff').insert(s).select());
  clearCache('staff:');
  return r;
}

export async function updateStaff(id, patch) {
  const cloud = await getCloud();
  const r = await unwrap(cloud.database.from('staff').update(patch).eq('id', id).select());
  clearCache('staff:');
  return r;
}

export async function addProject(p) {
  const cloud = await getCloud();
  const r = await unwrap(cloud.database.from('projects').insert(p).select());
  clearCache('projects:');
  return r;
}

export async function updateProject(id, patch) {
  const cloud = await getCloud();
  const r = await unwrap(
    cloud.database.from('projects').update(patch).eq('id', id).select()
  );
  clearCache('projects:');
  return r;
}

/* ============ 每日任务填报（需求 5，最高频） ============ */

/**
 * 某天的填报记录。
 * @param {string} date  YYYY-MM-DD
 * @param {string} [user] 只取这个人的（员工端用）；不传则取全员（管理端用）
 */
async function loadTasksByDate(date, user) {
  const cloud = await getCloud();
  const base = cloud.database
    .from('task_entries')
    .select('id,user_name,project_code,project_name,task_text,hours,source,created_at,task_id,task_name')
    .eq('entry_date', date);
  // 服务端过滤：员工端只看自己 —— 若在客户端筛，limit 会被别人的记录先占满
  const q = user ? base.eq('user_name', user) : base;
  return unwrap(q.order('created_at', { ascending: true }));
}
export function fetchTasksByDate(date, user) {
  return cachedRead(`entries:${date}:${user || '*'}`, () => loadTasksByDate(date, user));
}

async function loadRecentTasks(limit) {
  const cloud = await getCloud();
  return unwrap(
    cloud.database
      .from('task_entries')
      .select('id,entry_date,user_name,project_code,project_name,task_text,hours,source,task_id,task_name')
      .order('entry_date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(limit)
  );
}
export function fetchRecentTasks(limit = 200) {
  return cachedRead(`recent:${limit}`, () => loadRecentTasks(limit));
}

/** 某个人的最近填报记录（员工端「填报记录」筛「只看我的」用）。
 *  必须服务端过滤：若取全员再在客户端筛，limit 会被别人的记录先占满，
 *  本人的记录反而可能一条都刷不出来。 */
async function loadRecentTasksByUser(limit, user) {
  const cloud = await getCloud();
  return unwrap(
    cloud.database
      .from('task_entries')
      .select('id,entry_date,user_name,project_code,project_name,task_text,hours,source,task_id,task_name')
      .eq('user_name', user)
      .order('entry_date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(limit)
  );
}
export function fetchRecentTasksByUser(limit = 200, user) {
  return cachedRead(`recent:${limit}:${user || '*'}`, () => loadRecentTasksByUser(limit, user));
}

/** 按日期范围查（管理员汇总用）。from/to 均为 YYYY-MM-DD，闭区间。 */
async function loadTasksInRange(from, to, limit) {
  const cloud = await getCloud();
  return unwrap(
    cloud.database
      .from('task_entries')
      .select('id,entry_date,user_name,project_code,project_name,task_text,hours,source,created_at,task_id,task_name')
      .gte('entry_date', from)
      .lte('entry_date', to)
      .order('entry_date', { ascending: false })
      .order('user_name', { ascending: true })
      .limit(limit)
  );
}
export function fetchTasksInRange(from, to, limit = 3000) {
  return cachedRead(`range:${from}:${to}:${limit}`, () => loadTasksInRange(from, to, limit));
}

export async function addTask(entry) {
  const cloud = await getCloud();
  const r = await unwrap(
    cloud.database
      .from('task_entries')
      .insert({
        entry_date: entry.entry_date,
        user_name: entry.user_name,
        project_code: entry.project_code || null,
        project_name: entry.project_name || null,
        task_id: entry.task_id ?? null,
        task_name: entry.task_name || null,
        task_text: entry.task_text,
        source: entry.source || 'quicknote',
      })
      .select()
  );
  clearCache('entries:');
  clearCache('recent:');
  clearCache('range:');
  return r;
}

export async function updateTask(id, patch) {
  const cloud = await getCloud();
  const r = await unwrap(
    cloud.database.from('task_entries').update(patch).eq('id', id).select()
  );
  clearCache('entries:');
  clearCache('recent:');
  clearCache('range:');
  return r;
}

export async function deleteTask(id) {
  const cloud = await getCloud();
  const r = await unwrap(cloud.database.from('task_entries').delete().eq('id', id).select());
  clearCache('entries:');
  clearCache('recent:');
  clearCache('range:');
  return r;
}

/**
 * 单独填/改/清工时（两段式填报：早上填内容，下班补工时）。
 * hours 传 null 表示清除工时。合法范围 0 < h <= 24，由调用方校验。
 */
export async function updateTaskHours(id, hours) {
  const cloud = await getCloud();
  const r = await unwrap(
    cloud.database.from('task_entries').update({ hours }).eq('id', id).select()
  );
  clearCache('entries:');
  clearCache('recent:');
  clearCache('range:');
  return r;
}

/* ============ 客户跟进（需求 3） ============ */

/**
 * 最近的客户跟进记录。
 * @param {number} [limit]
 * @param {string} [user] 只取这个人的（员工端用）；不传则取全员（管理端用）
 */
async function loadFollowups(limit, user) {
  const cloud = await getCloud();
  const base = cloud.database
    .from('customer_followups')
    .select('id,follow_date,user_name,customer,project_code,content,feedback,contact');
  const q = user ? base.eq('user_name', user) : base;
  return unwrap(q.order('follow_date', { ascending: false }).limit(limit));
}
export function fetchFollowups(limit = 100, user) {
  return cachedRead(`followups:${user || '*'}:${limit}`, () => loadFollowups(limit, user));
}

/** 按日期范围取客户跟进（导出用，与 task_entries 口径一致） */
async function loadFollowupsInRange(from, to, limit) {
  const cloud = await getCloud();
  return unwrap(
    cloud.database
      .from('customer_followups')
      .select('id,follow_date,user_name,customer,project_code,content,feedback,contact')
      .gte('follow_date', from)
      .lte('follow_date', to)
      .order('follow_date', { ascending: false })
      .limit(limit)
  );
}
export function fetchFollowupsInRange(from, to, limit = 1000) {
  return cachedRead(`fup-range:${from}:${to}:${limit}`, () => loadFollowupsInRange(from, to, limit));
}

export async function addFollowup(f) {
  const cloud = await getCloud();
  const r = await unwrap(
    cloud.database
      .from('customer_followups')
      .insert({
        follow_date: f.follow_date,
        user_name: f.user_name,
        customer: f.customer || null,
        project_code: f.project_code || null,
        content: f.content,
        feedback: f.feedback || null,
        contact: f.contact || null,
      })
      .select()
  );
  clearCache('followups:');
  clearCache('fup-range:');
  return r;
}

/* ============ 完工回访（需求 4） ============ */

/**
 * 最近的完工回访记录。
 * @param {number} [limit]
 * @param {string} [user] 只取这个人的（员工端用）；不传则取全员（管理端用）
 */
async function loadReviews(limit, user) {
  const cloud = await getCloud();
  const base = cloud.database
    .from('completion_reviews')
    .select('id,review_date,reviewer,project_code,project_name,customer,score,content');
  const q = user ? base.eq('reviewer', user) : base;
  return unwrap(q.order('review_date', { ascending: false }).limit(limit));
}
export function fetchReviews(limit = 100, user) {
  return cachedRead(`reviews:${user || '*'}:${limit}`, () => loadReviews(limit, user));
}

/** 按日期范围取完工回访（导出用） */
async function loadReviewsInRange(from, to, limit) {
  const cloud = await getCloud();
  return unwrap(
    cloud.database
      .from('completion_reviews')
      .select('id,review_date,reviewer,project_code,project_name,customer,score,content')
      .gte('review_date', from)
      .lte('review_date', to)
      .order('review_date', { ascending: false })
      .limit(limit)
  );
}
export function fetchReviewsInRange(from, to, limit = 1000) {
  return cachedRead(`rev-range:${from}:${to}:${limit}`, () => loadReviewsInRange(from, to, limit));
}

export async function addReview(r) {
  const cloud = await getCloud();
  const saved = await unwrap(
    cloud.database
      .from('completion_reviews')
      .insert({
        review_date: r.review_date,
        reviewer: r.reviewer,
        project_code: r.project_code || null,
        project_name: r.project_name || null,
        customer: r.customer || null,
        score: r.score ?? null,
        content: r.content,
      })
      .select()
  );
  clearCache('reviews:');
  clearCache('rev-range:');
  return saved;
}

/* ============ 连通性自检：返回 { ok, count, error } ============ */
export async function ping() {
  try {
    const cloud = await getCloud();
    const rows = await unwrap(
      cloud.database.from('projects').select('id').limit(1)
    );
    return { ok: true, count: Array.isArray(rows) ? rows.length : 0 };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
