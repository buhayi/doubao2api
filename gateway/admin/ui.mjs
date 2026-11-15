// SPDX-License-Identifier: AGPL-3.0-only
const paths = {
  users: ["M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2", "M16 3a4 4 0 0 1 0 8", "M22 21v-2a4 4 0 0 0-3-3.87"],
  layers: ["m12 3 9 5-9 5-9-5 9-5Z", "m3 12 9 5 9-5", "m3 16 9 5 9-5"],
  settings: ["M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z", "m9 3-.8 2.4-2.5.5-1.7 3 1.3 1.9-.3 2.3L3.5 15l1.7 3 2.5.3L9 21h6l.8-2.4 2.5-.5 1.7-3-1.3-1.9.3-2.3 1.5-1.9-1.7-3-2.5-.3L15 3H9Z"],
  shield: ["M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7l-9-4Z", "m8 12 3 3 5-6"],
  plus: ["M12 5v14", "M5 12h14"],
  refresh: ["M20 7v5h-5", "M4 17v-5h5", "M6.5 6.5A8 8 0 0 1 20 12", "M4 12a8 8 0 0 0 13.5 5.5"],
  pulse: ["M2 12h4l3-8 6 16 3-8h4"],
  search: ["M21 21l-5-5"],
  star: ["m12 3 2.8 5.7 6.3.9-4.5 4.4 1 6.2-5.6-3-5.6 3 1-6.2L2.9 9.6l6.3-.9L12 3Z"],
  chevron: ["m9 5 7 7-7 7"],
  close: ["m6 6 12 12", "M18 6 6 18"],
  check: ["m5 12 4 4L19 6"],
  copy: ["M9 9h12v12H9Z", "M5 15H3V3h12v2"],
  external: ["M15 3h6v6", "m10 14 11-11", "M21 14v7H3V3h7"],
  browser: ["M3 4h18v16H3Z", "M3 9h18", "M6 6.5h.01", "M9 6.5h.01"],
  alert: ["m12 3 10 18H2L12 3Z", "M12 9v4", "M12 17h.01"],
  trash: ["M3 6h18", "M9 6V3h6v3", "m5 6 1 15h12l1-15", "M10 10v7", "M14 10v7"],
  key: ["m15 9 6-6", "m18 6 3 3"],
};
export function node(tag, attributes = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") element.className = value;
    else if (key.startsWith("on") && typeof value === "function") element.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === "value") element.value = value;
    else element.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child !== undefined && child !== null && child !== false) element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}
export function icon(name, size = 18) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [key, value] of Object.entries({ viewBox: "0 0 24 24", width: size, height: size, fill: "none", stroke: "currentColor", "stroke-width": "1.75", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(key, value);
  for (const d of paths[name] || []) {
    const path = document.createElementNS(svg.namespaceURI, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  if (["users", "search", "key"].includes(name)) {
    const circle = document.createElementNS(svg.namespaceURI, "circle");
    const geometry = name === "users" ? { cx: 9, cy: 7, r: 4 } : name === "search" ? { cx: 10.5, cy: 10.5, r: 6.5 } : { cx: 8, cy: 16, r: 5 };
    for (const [key, value] of Object.entries(geometry)) circle.setAttribute(key, value);
    svg.append(circle);
  }
  return svg;
}
export function button(text, { kind = "secondary", symbol, onClick, disabled = false, title, className = "", ...attributes } = {}) {
  return node("button", { type: "button", class: `button ${kind} ${className}`.trim(), onClick, disabled, title, ...attributes }, symbol && icon(symbol, 16), text);
}
export function iconButton(symbol, label, onClick, disabled = false, className = "") {
  return button(null, { symbol, title: label, "aria-label": label, kind: "icon-button", className, onClick, disabled });
}
export function searchField(placeholder, value, onInput) {
  return node("label", { class: "search-field" }, icon("search", 16), node("input", { type: "search", "aria-label": placeholder, placeholder, value, onInput }));
}
export function pageHeading(title, description, ...actions) {
  return node("div", { class: "page-heading" }, node("div", { class: "heading-copy" }, node("h1", {}, title), node("p", {}, description)), node("div", { class: "heading-actions" }, actions));
}
export function emptyState(title, description, action, symbol = "users") {
  return node("div", { class: "empty-state" }, node("div", { class: "empty-icon" }, icon(symbol, 26)), node("h3", {}, title), node("p", {}, description), action);
}
export function avatarTone(seed = "") {
  let hash = 0;
  for (const ch of String(seed)) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return `tone-${hash % 6}`;
}
export const statusMeta = {
  unchecked: ["待检测", "neutral"], ok: ["会话有效", "success"], expired: ["登录已失效", "danger"],
  limited: ["请求受限", "warning"], verification: ["需要官网验证", "warning"], error: ["检测未通过", "danger"],
};
export function statusPill(text, kind = "neutral") {
  return node("span", { class: `status-pill ${kind}` }, node("span", { class: "status-dot" }), text);
}
export function formatDate(value, includeYear = false) {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", ...(includeYear ? { year: "numeric" } : {}), month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}
function percent(window) {
  if (Number.isFinite(window.used)) return Math.min(100, Math.max(0, window.used));
  if (Number.isFinite(window.amount) && Number.isFinite(window.limit) && window.limit > 0) return Math.min(100, 100 * window.amount / window.limit);
  return null;
}
export function quotaBlock(check, compact = false) {
  const windows = check?.usage?.windows || [];
  const source = compact ? windows.slice(0, 1) : windows;
  if (!source.length) return node("div", { class: "quota-unavailable" }, check?.usageError || (check?.source === "probe" ? "刷新状态查看额度" : check?.state === "ok" ? "上游暂无额度信息" : "检测后查看额度"));
  return node("div", { class: compact ? "quota-compact" : "quota-list" }, source.map((window) => {
    const used = percent(window);
    const value = window.display || (Number.isFinite(window.used) ? `已用 ${Number(window.used.toFixed(1))}%` : Number.isFinite(window.amount) && Number.isFinite(window.limit) ? `${window.amount} / ${window.limit} ${window.unit || "额度"}` : "暂无额度信息");
    return node("div", { class: "quota-item" }, node("div", { class: "quota-caption" }, node("span", {}, window.name || "使用额度"), node("strong", {}, value)), used !== null && node("progress", { class: used >= 90 ? "quota-progress warning" : "quota-progress", max: 100, value: used, "aria-label": `${window.name || "额度"}已使用 ${used.toFixed(1)}%` }), !compact && (window.resetsAt || window.runsOutAt) && node("small", { class: "muted" }, `${window.runsOutAt ? "到期" : "重置"}时间：${formatDate((window.runsOutAt || window.resetsAt) * 1000, true)}`));
  }));
}
export function accountRow(account, actions, busy = false, probing = false) {
  const [session, kind] = statusMeta[account.check.state] || statusMeta.unchecked;
  return node("tr", { class: account.default ? "is-default" : "" },
    node("td", {}, node("div", { class: "account-identity" }, node("span", { class: `account-avatar ${avatarTone(account.uid || account.name)}` }, (account.name || "豆").slice(0, 1)), node("div", { class: "identity-copy" }, node("div", { class: "account-title" }, node("button", { class: "name-button", type: "button", onClick: () => actions.manage(account) }, account.name), account.default && node("span", { class: "default-tag" }, icon("star", 11), "默认")), node("small", { class: "mono muted uid-chip" }, account.uid)))),
    node("td", {}, node("div", { class: "status-stack" }, statusPill(account.invalid ? "失效账号" : account.enabled ? "已启用" : "已停用", account.invalid ? "danger" : account.enabled ? "success" : "neutral"), node("div", { class: `session-state ${kind}`, title: account.check.message || "" }, node("span", { class: "session-dot" }), account.check.source === "probe" && account.check.state === "ok" ? "探活通过" : session))),
    node("td", {}, quotaBlock(account.check, true)),
    node("td", { class: "date-cell" }, node("span", { class: "date-primary" }, formatDate(account.updatedAt)), node("small", { class: "muted" }, account.check.checkedAt ? `${formatDate(account.check.checkedAt)} ${account.check.source === "probe" ? "探活" : account.check.source === "request" ? "请求" : "检测"}` : "尚未检测会话")),
    node("td", {}, node("div", { class: "row-actions" }, button(probing ? "探活中" : "探活", { kind: "quiet", symbol: "pulse", title: `探活 ${account.name}`, "aria-label": `探活 ${account.name}`, onClick: () => actions.probe(account), disabled: busy }), iconButton("refresh", `检测 ${account.name}`, () => actions.check(account), busy, busy ? "is-busy" : ""), iconButton("star", account.default ? "当前默认账号" : `将 ${account.name} 设为默认`, () => actions.use(account), busy || account.default || !account.enabled || account.invalid, account.default ? "is-active-star" : ""), button("管理", { kind: "quiet", onClick: () => actions.manage(account), disabled: busy, symbol: "chevron" }))),
  );
}
