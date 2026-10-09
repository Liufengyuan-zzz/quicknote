/**
 * view-guard.js — 视图渲染竞态防护
 *
 * 所有视图都往 `#rp-body` 里写内容，而渲染流程是「先 await 接口 → 再写 DOM」。
 * 如果先点了响应慢的 A，又点了 B：B 先渲染好，A 的请求稍后才返回，
 * 它照样把自己的整页内容写进去 —— 表现就是「切到别的 tab 了，页面还停在上一个 tab」。
 *
 * 用法：渲染开始 `const t = beginView()`；每次 await 之后、写 DOM 之前
 * `if (staleView(t)) return;`。令牌被后来的渲染顶掉即视为过期，直接丢弃这次结果。
 *
 * 注意：令牌是**全局一个**（report.js 与 admin.js 共用）。因为可见容器只有一个，
 * 任何一次新渲染都应该让所有在飞的旧渲染作废。
 */

let seq = 0;

export function beginView() {
  return ++seq;
}

export function staleView(token) {
  return token !== seq;
}
