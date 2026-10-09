/**
 * auth.js — 登录门禁
 *
 * 为什么需要它：
 *   数据的安全边界在服务端（数据库 RLS）——只有「已登录 + 邮箱域名 = @shmatching.com」
 *   的请求才能读写任何一张表。所以客户端这边除了要能登录，还必须做到：
 *   **未登录 / 登出时清空本地缓存**，否则换个人用同一台机器仍能翻到上一个人留下的数据。
 *
 * 登录方式（SDK 的 cloud.auth）：
 *   验证码：sendOtp → verifyOtp（新邮箱首次注册时必须同时设置密码）
 *   密码：  signInWithPassword（账号需先用验证码注册过一次）
 *   忘记密码不必单独的流程 —— 直接用验证码登录即可，这是天然的找回途径。
 *
 * ★ 两个必须遵守的 SDK 契约（写错了会静默失效）：
 *   1. 「获取验证码」和「提交」必须是两个独立动作：发送时保存 challenge，
 *      提交时只验它，绝不重新发送。重试错误验证码也不能重发。
 *   2. 新邮箱注册必须带密码，老用户登录不能带（password 传 undefined）。
 */

import { getCloud, clearCache } from './cloud.js';

export const ALLOWED_DOMAIN = 'shmatching.com';

/** 与数据库 RLS 的口径保持一致：邮箱必须以 @shmatching.com 结尾 */
export function emailAllowed(email) {
  return String(email ?? '').trim().toLowerCase().endsWith('@' + ALLOWED_DOMAIN);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 把 SDK 的英文错误翻成人话；未识别的原样透出，便于排查 */
function humanizeText(err) {
  const kind = err && err.kind ? String(err.kind) : '';
  const msg = String((err && err.message) || err || '');
  const low = msg.toLowerCase();
  if (kind === 'network' || /network|fetch|timeout|abort/i.test(low)) {
    return '网络连接失败，请检查网络后重试';
  }
  if (/invalid.*(code|token)|code.*(invalid|expired)|verification/i.test(low)) {
    return '验证码不正确或已过期，请重新获取';
  }
  if (/password/i.test(low) && /(invalid|wrong|incorrect)/i.test(low)) {
    return '邮箱或密码不正确';
  }
  if (/exist|already/i.test(low)) return '该邮箱已注册，请直接用验证码或密码登录';
  return msg || '操作失败，请重试';
}

/**
 * 在提示语后附加服务端诊断标记（错误码 / HTTP 状态 / 错误类别）。
 * 这些标记是定位问题的唯一线索（同一句英文可能由鉴权、续期、数据请求三处抛出，
 * 不带标记就只能靠猜），因此刻意保留、不做美化。
 */
function humanize(err) {
  const text = humanizeText(err);
  const tags = [
    err && err.code ? `code=${err.code}` : '',
    err && err.status ? `HTTP ${err.status}` : '',
    err && err.kind ? `kind=${err.kind}` : '',
  ].filter(Boolean).join(' ');
  return tags ? `${text}（${tags}）` : text;
}

/* ============ 会话 ============ */

/** currentUser() 拒绝放行的原因，给 finishLogin() 生成准确提示用 */
let lastGateReason = '';

/** 从 SDK 的会话对象里挖邮箱；挖不到返回 ''。
 *  ★ SDK 的会话 user 只有 { id, isAnonymous, raw }，**没有 email 字段**
 *    （userFromSessionPayload，SDK lib/index.js:149）。邮箱只可能出现在
 *    raw（登录响应的 claims）或 /v1/user/me（parseUser 才解析 email）里。 */
function emailFromSession(data) {
  const su = data && data.user;
  const raw = (su && su.raw) || {};
  return (su && su.email)
    || (typeof raw.email === 'string' && raw.email)
    || (raw.user_metadata && typeof raw.user_metadata.email === 'string' && raw.user_metadata.email)
    || '';
}

/** 当前登录用户（拿不到邮箱 / 域名不符则立即登出并返回 null） */
export async function currentUser() {
  let cloud;
  try { cloud = await getCloud(); } catch { return null; }
  try {
    const { data, error } = await cloud.auth.getSession();
    if (error || !data) {
      // 服务端判定会话「无效 / 已过期 / 属于另一个客户端」时，SDK 只在 JSON 解析失败时
      // 才清本地记录，服务端说无效时它不动 —— 结果就是每次启动都读到同一条坏凭证、
      // 反复报同一个错，用户无从自救。这里主动登出把它清掉，下次即可干净地重新登录。
      if (error) { try { await cloud.auth.signOut(); } catch { /* 清不掉也继续 */ } }
      clearCache();
      lastGateReason = 'session';
      return null;
    }

    // 会话对象本身不带 email → 先看 raw claims，再问一次 /v1/user/me
    let email = emailFromSession(data);
    if (!email) {
      try {
        const me = await cloud.auth.getUser();
        const mu = me && me.data;
        email = (mu && (mu.email || (mu.user_metadata && mu.user_metadata.email))) || '';
      } catch { /* 取不到按未取到处理 */ }
    }

    if (!email) {
      // 连服务端都没给出邮箱：没法确认身份口径，宁可不放行（RLS 反正会兜底）。
      // 留一行现场，万一真出现还有得查。
      console.warn('[auth] 会话与 /v1/user/me 都没给出邮箱，会话原始字段：', data.user && data.user.raw);
      try { await cloud.auth.signOut(); } catch { /* ignore */ }
      clearCache();
      lastGateReason = 'no-email';
      return null;
    }
    if (!emailAllowed(email)) {
      // 能登录但域名不符：服务端 RLS 也会拒绝其数据请求，
      // 本地立刻退出，避免留一个「登录着但用不了」的僵局
      try { await cloud.auth.signOut(); } catch { /* ignore */ }
      clearCache();
      lastGateReason = 'domain';
      return null;
    }

    // 归一化：调用方只需要 { id, email }，SDK 两种 user 形状的差异在这里抹平
    const su = data.user || {};
    return { id: su.id || '', email, raw: su.raw || {} };
  } catch {
    return null;
  }
}

/** 主动退出：清本机会话与缓存，然后重新走门禁 */
export async function signOut() {
  try {
    const cloud = await getCloud();
    await cloud.auth.signOut();
  } catch { /* 退出失败也要清本地 */ }
  clearCache();
  if (typeof location !== 'undefined') location.reload();
}

/* ============ 登录界面 ============ */

let gateResolve = null;   // 门禁 Promise 的 resolve，登录成功后放行
let pendingOtp = null;    // { email, verificationId, isExistingUser }
let mode = 'otp';         // 'otp' | 'password'
let cdTimer = null;
let busy = false;

/**
 * 门禁：已登录直接返回用户；未登录则显示登录界面，
 * 直到登录成功才 resolve（调用方 await 它即可，不需要处理「取消」）。
 */
export async function ensureSignedIn() {
  const user = await currentUser();
  if (user) return user;
  clearCache();               // 未登录 → 清掉本机可能残留的他人数据
  return new Promise(resolve => {
    gateResolve = resolve;
    renderGate();
    const email = document.getElementById('auth-email');
    if (email) email.focus();
  });
}

function $(sel) { return document.querySelector(sel); }
function val(sel) { const el = $(sel); return el ? el.value.trim() : ''; }

function say(text, kind = '') {
  const el = $('#auth-msg');
  if (!el) return;
  el.className = 'auth-msg' + (kind ? ' ' + kind : '');
  el.textContent = text;
}

function setBusy(on) {
  busy = on;
  const btn = $('#auth-submit');
  const send = $('#auth-send');
  if (btn) { btn.disabled = on; btn.textContent = on ? '请稍候…' : (mode === 'password' ? '登录' : '登录 / 注册'); }
  if (send) send.disabled = on || !!cdTimer;
}

function hideGate() {
  const gate = document.getElementById('auth-gate');
  if (gate) { gate.hidden = true; gate.innerHTML = ''; }
  document.body.classList.remove('auth-locked');
}

async function finishLogin() {
  const user = await currentUser();
  if (!user) {
    // 两种失败原因给不同提示：域名不符是用户能自己改的；其余是程序/服务端问题
    throw new Error(lastGateReason === 'domain'
      ? `请使用 @${ALLOWED_DOMAIN} 结尾的公司邮箱`
      : '登录状态未生效，请重试；若反复出现请截图反馈');
  }
  clearCache();                       // 换人登录后从服务端重新取，避免看到上一个人的缓存
  hideGate();
  const resolve = gateResolve;
  gateResolve = null;
  if (resolve) resolve(user);
}

function startCountdown(seconds) {
  const btn = $('#auth-send');
  let left = seconds;
  clearInterval(cdTimer);
  const tick = () => {
    if (!btn) return;
    if (left <= 0) {
      clearInterval(cdTimer);
      cdTimer = null;
      btn.disabled = false;
      btn.textContent = '重新获取';
      return;
    }
    btn.disabled = true;
    btn.textContent = `${left}s 后重发`;
    left -= 1;
  };
  tick();
  cdTimer = setInterval(tick, 1000);
}

/** 获取验证码（独立动作，不在提交里调用） */
async function onSend() {
  if (busy || cdTimer) return;
  const email = val('#auth-email');
  if (!email) return say('请输入邮箱', 'err');
  if (!emailAllowed(email)) return say(`请使用 @${ALLOWED_DOMAIN} 结尾的公司邮箱`, 'err');

  setBusy(true);
  say('正在发送验证码…');
  try {
    const cloud = await getCloud();
    const { data, error } = await cloud.auth.sendOtp({ email });
    if (error) throw error;
    pendingOtp = {
      email,
      verificationId: data && data.verificationId,
      isExistingUser: !!(data && data.isExistingUser),
    };
    startCountdown(60);
    say('验证码已发送，请查收邮箱（若没收到请翻一下垃圾邮件）', 'ok');
    const code = $('#auth-code');
    if (code) code.focus();
  } catch (e) {
    console.error('[auth] 原始错误：', e);
    say(humanize(e), 'err');
  } finally {
    setBusy(false);
  }
}

/** 提交（只验证已保存的 challenge，绝不在这里重新发送） */
async function onSubmit(ev) {
  if (ev) ev.preventDefault();
  if (busy) return;
  const email = val('#auth-email');
  if (!email) return say('请输入邮箱', 'err');
  if (!emailAllowed(email)) return say(`请使用 @${ALLOWED_DOMAIN} 结尾的公司邮箱`, 'err');

  setBusy(true);
  say('正在登录…');
  try {
    const cloud = await getCloud();
    if (mode === 'password') {
      const password = val('#auth-pwd');
      if (!password) throw new Error('请输入密码');
      const { error } = await cloud.auth.signInWithPassword({ email, password });
      if (error) throw error;
    } else {
      const token = val('#auth-code');
      if (!token) throw new Error('请输入邮箱收到的验证码');
      if (!pendingOtp || pendingOtp.email !== email) {
        throw new Error('请先点击「获取验证码」');
      }
      const password = val('#auth-pwd');
      if (!pendingOtp.isExistingUser && !password) {
        throw new Error('首次登录需要设置一个密码（以后可凭它直接登录）');
      }
      const { error } = await cloud.auth.verifyOtp({
        email: pendingOtp.email,
        verificationId: pendingOtp.verificationId,
        isExistingUser: pendingOtp.isExistingUser,
        token,
        password: pendingOtp.isExistingUser ? undefined : password,
      });
      if (error) throw error;
    }
    pendingOtp = null;
    await finishLogin();
  } catch (e) {
    console.error('[auth] 原始错误：', e);
    say(humanize(e), 'err');
  } finally {
    setBusy(false);
  }
}

function switchMode(next) {
  mode = next;
  const otpRow = $('#auth-otp-row');
  const hint = $('#auth-pwd-hint');
  const toggle = $('#auth-mode-toggle');
  const first = $('#auth-title-sub');
  if (otpRow) otpRow.hidden = next === 'password';
  if (hint) hint.textContent = next === 'password' ? '账号需先用验证码注册过一次' : '首次登录请设置（至少 6 位）；已注册过可留空';
  if (toggle) toggle.textContent = next === 'password' ? '改用邮箱验证码登录' : '改用密码登录';
  if (first) first.textContent = next === 'password' ? '用邮箱和密码登录' : '用公司邮箱收验证码登录';
  say('');
  setBusy(false);
}

function renderGate() {
  const gate = document.getElementById('auth-gate');
  if (!gate) return;
  document.body.classList.add('auth-locked');
  gate.hidden = false;
  gate.innerHTML = `
    <div class="auth-card">
      <h2>QuickNote</h2>
      <p class="auth-sub" id="auth-title-sub">用公司邮箱收验证码登录</p>
      <form id="auth-form" autocomplete="on">
        <label class="auth-field">
          <span>邮箱</span>
          <input id="auth-email" type="email" placeholder="name@${ALLOWED_DOMAIN}"
                 autocomplete="username" spellcheck="false" />
        </label>

        <div class="auth-otp-row" id="auth-otp-row">
          <label class="auth-field">
            <span>验证码</span>
            <input id="auth-code" type="text" inputmode="numeric" maxlength="6"
                   placeholder="6 位数字" autocomplete="one-time-code" />
          </label>
          <button type="button" id="auth-send" class="auth-send">获取验证码</button>
        </div>

        <label class="auth-field">
          <span>密码</span>
          <input id="auth-pwd" type="password" placeholder="至少 6 位" autocomplete="current-password" />
          <i class="auth-hint" id="auth-pwd-hint">首次登录请设置（至少 6 位）；已注册过可留空</i>
        </label>

        <p class="auth-msg" id="auth-msg"></p>
        <button type="submit" id="auth-submit" class="auth-primary">登录 / 注册</button>
      </form>
      <div class="auth-alt">
        <button type="button" id="auth-mode-toggle" class="auth-link">改用密码登录</button>
        <span class="auth-sep"></span>
        <span class="auth-tip">忘记密码？直接用验证码登录即可</span>
      </div>
    </div>`;

  const form = $('#auth-form');
  if (form) form.addEventListener('submit', onSubmit);
  const send = $('#auth-send');
  if (send) send.addEventListener('click', onSend);
  const toggle = $('#auth-mode-toggle');
  if (toggle) toggle.addEventListener('click', () => switchMode(mode === 'otp' ? 'password' : 'otp'));
  const email = $('#auth-email');
  if (email) {
    // 只在离开输入框时提示域名问题，输入过程中不打扰
    email.addEventListener('blur', () => {
      const v = email.value.trim();
      if (v && !emailAllowed(v)) say(`请使用 @${ALLOWED_DOMAIN} 结尾的公司邮箱`, 'err');
      else if (v) say('');
    });
    email.addEventListener('input', () => { if (cdTimer) return; say(''); });
  }
  mode = 'otp';
  setBusy(false);
}
