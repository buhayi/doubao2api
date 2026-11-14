// SPDX-License-Identifier: AGPL-3.0-only
import { node, icon, button, iconButton, searchField, pageHeading, emptyState, accountRow, statusPill, statusMeta, checkinBlock, quotaBlock, formatDate, avatarTone } from "./ui.mjs";

const content = document.getElementById("content");
const state = {
  view: "accounts", accounts: [], gateway: {}, login: { state: "idle", active: false },
  filter: "all", search: "", token: "", checking: new Set(), checkingAll: false,
  modelUid: "", models: [], modelSearch: "", modelLoading: false, modelError: "",
  settings: null, apiKey: "", syncError: "", drawerUid: null, clientProtocol: "chat",
  checkin: { state: "idle", active: false, results: [] }, checkinStarting: false, checkinExpanded: true,
};
let loginDialog, drawer, loginTimer, checkinTimer, toastTimer, refreshTask, modelRequest = 0, loginMode = "form", drawerDraft = "";
const names = { accounts: "账号池", models: "模型目录", settings: "接入配置" };

async function session() {
  const response = await fetch("/api/session", { cache: "no-store" });
  if (!response.ok) throw Error("无法连接本机管理台，请检查服务是否正在运行。");
  state.token = (await response.json()).token;
}
async function request(path, { method = "GET", body } = {}, retry = true) {
  const response = await fetch(path, { method, cache: "no-store", headers: { "X-Doubao-Admin": state.token, ...(method !== "GET" ? { "Content-Type": "application/json" } : {}) }, ...(method !== "GET" ? { body: JSON.stringify(body || {}) } : {}) });
  let result;
  try { result = await response.json(); } catch { throw Error("服务返回了无效响应，请刷新页面。"); }
  if (!response.ok) {
    if (response.status === 403 && retry && result.error?.message?.includes("会话已失效")) { await session(); return request(path, { method, body }, false); }
    throw Error(result.error?.message || "操作未完成，请稍后重试。");
  }
  return result;
}
const accountPath = (uid, action = "") => `/api/accounts/${encodeURIComponent(uid)}${action ? "/" + action : ""}`;
function toast(message, error = false) {
  clearTimeout(toastTimer);
  const region = document.getElementById("toast-region");
  region.replaceChildren(node("div", { class: `toast${error ? " error" : ""}` }, icon(error ? "alert" : "check"), message));
  toastTimer = setTimeout(() => region.replaceChildren(), error ? 6000 : 3500);
}
async function copy(value, label) {
  try { await navigator.clipboard.writeText(value); toast(`${label}已复制`); }
  catch { toast("浏览器暂无法复制，请选中内容手动复制。", true); }
}
function connectionState() {
  document.getElementById("gateway-state").replaceChildren(node("span", { class: `status-dot ${state.gateway.online ? "success" : "neutral"}` }), state.gateway.online ? "API 网关在线" : "API 网关未启动");
}
function banners() {
  const result = [];
  if (state.syncError) result.push(node("div", { class: "info-banner error", role: "alert" }, icon("alert"), state.syncError, button("重试", { kind: "quiet", onClick: () => void refresh().catch((error) => toast(error.message, true)) })));
  if (state.login.active) result.push(node("div", { class: "info-banner" }, icon("browser"), "有一个账号正在登录，完成后会自动加入账号池。", button("查看登录", { kind: "quiet", onClick: openLogin })));
  if (state.gateway.fixedAccountId) result.push(node("div", { class: "info-banner warning" }, icon("alert"), node("span", {}, "网关已固定使用账号 ", node("span", { class: "mono" }, state.gateway.fixedAccountId), "，固定配置优先于默认账号。")));
  return result;
}
async function refresh({ live = false } = {}) {
  if (refreshTask) return refreshTask;
  refreshTask = (async () => {
    try {
      const result = await request("/api/overview");
      const previousDrawer = state.accounts.find((account) => account.uid === state.drawerUid);
      const previousError = state.syncError;
      const wasSigning = state.checkin.active;
      state.accounts = result.accounts;
      state.gateway = result.gateway;
      state.syncError = "";
      acceptLogin(result.login);
      acceptCheckin(result.checkin);
      connectionState();
      if (live && !previousError) {
        if (state.view === "accounts") { renderCheckinButton(); renderCheckinPanel(); renderAccountRows(); }
      } else renderView();
      const currentDrawer = state.accounts.find((account) => account.uid === state.drawerUid);
      if (drawer?.open && (wasSigning !== state.checkin.active || JSON.stringify([previousDrawer?.check, previousDrawer?.checkin]) !== JSON.stringify([currentDrawer?.check, currentDrawer?.checkin]))) renderDrawerStatus();
    } catch (error) {
      state.syncError = "管理台连接中断，请检查服务后重试。";
      renderView();
      throw error;
    } finally { refreshTask = null; }
  })();
  return refreshTask;
}
function renderView() {
  document.title = `${names[state.view]} · 豆包工作`;
  document.getElementById("breadcrumb").textContent = names[state.view];
  for (const element of document.querySelectorAll("[data-view]")) {
    const active = element.dataset.view === state.view;
    element.classList.toggle("active", active);
    if (active) element.setAttribute("aria-current", "page"); else element.removeAttribute("aria-current");
  }
  if (state.view === "models") renderModels();
  else if (state.view === "settings") renderSettings();
  else renderAccounts();
}
function metric(label, value, note, { accent = false, account = false, symbol, tone = "slate" } = {}) {
  return node("div", { class: `metric metric-${tone}` }, node("div", { class: "metric-top" }, node("div", { class: "metric-label" }, label), symbol && node("span", { class: `metric-icon ${tone}` }, icon(symbol, 15))), node("div", { class: `metric-value${accent ? " accent" : ""}${account ? " account-metric" : ""}`, title: String(value) }, value), node("div", { class: "metric-note" }, note));
}
function renderAccounts() {
  const enabled = state.accounts.filter((account) => account.enabled).length;
  const defaultAccount = state.accounts.find((account) => account.default);
  const checkButton = button(state.checkingAll ? "正在检测" : "刷新状态", { symbol: "refresh", className: state.checkingAll ? "spinner" : "", disabled: state.checkingAll || !enabled, onClick: () => void checkAll() });
  content.replaceChildren(
    pageHeading("账号池", "管理接入账号、登录会话与使用额度。", poolCheckinButton(), checkButton, button("添加账号", { kind: "primary", symbol: "plus", onClick: openLogin, disabled: state.accounts.length >= 64 })),
    ...banners(),
    node("section", { class: "metrics", "aria-label": "账号池概览" }, metric("账号总数", state.accounts.length, "最多接入 64 个账号", { symbol: "users", tone: "indigo" }), metric("已启用", enabled, "可设为网关服务账号", { accent: true, symbol: "shield", tone: "emerald" }), metric("已停用", state.accounts.length - enabled, "暂停用于网关请求", { symbol: "layers", tone: "slate" }), metric("默认账号", defaultAccount?.name || "未设置", defaultAccount?.uid || "添加或启用一个账号", { account: true, symbol: "star", tone: "amber" })),
    node("div", { id: "checkin-slot", hidden: !state.checkin.id }),
    node("section", { class: "pool-panel", "aria-label": "账号列表" },
      node("div", { class: "pool-toolbar" }, node("div", { class: "tabs", role: "tablist", "aria-label": "账号状态筛选" }, [["all", "全部账号", state.accounts.length], ["enabled", "已启用", enabled], ["disabled", "已停用", state.accounts.length - enabled]].map(([value, label, count]) => node("button", { type: "button", class: `tab${state.filter === value ? " active" : ""}`, role: "tab", "aria-selected": String(state.filter === value), onClick: () => { state.filter = value; renderAccounts(); } }, label, node("span", { class: "tab-count" }, count)))), searchField("搜索账号名称或 UID", state.search, (event) => { state.search = event.target.value; renderAccountRows(); })),
      node("div", { class: "table-scroll", id: "accounts-table-wrap" }, node("table", { class: "accounts-table", "aria-label": "账号池" }, node("thead", {}, node("tr", {}, ["账号", "状态", "使用额度", "今日签到", "最近更新", "操作"].map((title) => node("th", { scope: "col" }, title)))), node("tbody", { id: "account-rows" }))),
      node("div", { id: "account-empty" }),
      node("p", { class: "mobile-hint", id: "table-hint" }, "左右滑动查看完整账号信息"),
      node("div", { class: "pool-footer" }, node("span", { id: "account-count" }), node("span", { class: "sync-state" }, node("span", { class: "status-dot" }), "每 15 秒同步账号池")),
    ),
  );
  renderAccountRows();
  renderCheckinPanel();
}
function renderAccountRows() {
  const query = state.search.trim().toLowerCase();
  const accounts = state.accounts.filter((account) => (state.filter === "all" || account.enabled === (state.filter === "enabled")) && (!query || `${account.name} ${account.uid}`.toLowerCase().includes(query)));
  const table = document.getElementById("account-rows");
  if (!table) return;
  table.replaceChildren(...accounts.map((account) => accountRow(account, { manage: openDrawer, check: checkAccount, checkin: startCheckin, use: useAccount }, state.checking.has(account.uid), state.checkinStarting || state.checkin.active)));
  document.getElementById("accounts-table-wrap").hidden = !accounts.length;
  document.getElementById("table-hint").hidden = !accounts.length;
  const empty = document.getElementById("account-empty");
  empty.replaceChildren();
  if (!accounts.length) empty.append(state.accounts.length ? emptyState("没有匹配的账号", "试试其他名称、UID 或账号状态。", button("重置筛选", { onClick: () => { state.search = ""; state.filter = "all"; renderAccounts(); } }), "search") : emptyState("接入你的第一个账号", "通过独立浏览器登录豆包工作，完成确认后即可在这里管理账号。", button("添加账号", { kind: "primary", symbol: "plus", onClick: openLogin })));
  document.getElementById("account-count").textContent = accounts.length === state.accounts.length ? `共 ${state.accounts.length} 个账号` : `显示 ${accounts.length} / ${state.accounts.length} 个账号`;
}
function poolCheckinButton() {
  return button(state.checkinStarting ? "正在发起" : state.checkin.active ? "签到进行中" : "一键签到", {
    id: "pool-checkin", symbol: "gift", disabled: state.checkinStarting || state.checkin.active || !state.accounts.some((account) => account.enabled),
    title: "为所有已启用账号查询签到并领取今日奖励", onClick: () => void startCheckin(),
  });
}
function renderCheckinButton() { document.getElementById("pool-checkin")?.replaceWith(poolCheckinButton()); }
function checkinSummary(job) {
  const claimed = job.counts?.claimed || 0, done = job.counts?.done || 0;
  return `新领取 ${claimed} · 已签到 ${done} · 未领取 ${Math.max(0, job.completed - claimed - done)}`;
}
function renderCheckinPanel() {
  const slot = document.getElementById("checkin-slot");
  if (!slot) return;
  const job = state.checkin;
  slot.hidden = !job.id;
  if (!job.id) { slot.replaceChildren(); return; }
  const heading = job.kind === "single" ? "账号签到" : "批量签到";
  const description = job.active ? `正在处理 ${job.current?.name || "签到队列"}` : `${job.completed} 个账号处理完毕`;
  slot.replaceChildren(node("section", { class: "panel checkin-panel", "aria-label": "签到结果" },
    node("div", { class: "checkin-heading" }, node("div", { class: "checkin-title" }, node("span", { class: "checkin-icon" }, icon("gift", 20)), node("div", {}, node("h2", {}, heading), node("p", {}, `${job.day} · 北京时间`))), statusPill(job.active ? "进行中" : job.state === "cancelled" ? "已停止" : "已完成", job.active ? "accent" : "neutral")),
    node("div", { class: "checkin-progress-line", role: "status", "aria-live": "polite" }, node("span", {}, description), node("strong", {}, `${job.completed} / ${job.total}`)),
    node("progress", { class: "quota-progress checkin-progress", max: job.total || 1, value: job.completed, "aria-label": "签到进度" }),
    node("p", { class: "checkin-summary" }, checkinSummary(job)),
    node("details", { class: "checkin-details", open: state.checkinExpanded, onToggle: (event) => { state.checkinExpanded = event.target.open; } }, node("summary", {}, "逐项签到结果"),
      node("ul", { class: "checkin-results" }, (job.results || []).map((result) => node("li", {}, node("div", { class: "checkin-result-top" }, node("strong", { title: result.name }, result.name), checkinBlock(result, true)), node("p", {}, result.usageError || result.message)))),
    ),
  ));
}
async function startCheckin(account) {
  if (state.checkinStarting || state.checkin.active) return;
  state.checkinStarting = true;
  state.checkinExpanded = true;
  renderCheckinButton();
  if (state.view === "accounts") renderAccountRows();
  if (drawer?.open) renderDrawerStatus();
  try {
    acceptCheckin(await request(account ? accountPath(account.uid, "checkin") : "/api/checkin", { method: "POST" }));
    await refresh({ live: true });
  } catch (error) { toast(error.message, true); }
  finally {
    state.checkinStarting = false;
    renderCheckinButton();
    renderCheckinPanel();
    if (state.view === "accounts") renderAccountRows();
    if (drawer?.open) renderDrawerStatus();
  }
}
function acceptCheckin(job) {
  if (!job) return;
  const previous = state.checkin;
  state.checkin = job;
  if (previous.active && previous.id === job.id && !job.active) toast(`签到${job.state === "cancelled" ? "已停止" : "已完成"}：${checkinSummary(job)}`);
  if (!job.active) { clearTimeout(checkinTimer); checkinTimer = null; }
  else scheduleCheckin();
}
function scheduleCheckin() {
  if (checkinTimer || !state.checkin.active) return;
  checkinTimer = setTimeout(async () => {
    checkinTimer = null;
    try { await refresh({ live: true }); } catch { /* The connection banner offers a retry; keep observing the existing job. */ }
    scheduleCheckin();
  }, 1200);
}
async function checkAccount(account, { quiet = false } = {}) {
  if (state.checking.has(account.uid)) return false;
  state.checking.add(account.uid);
  if (state.view === "accounts") renderAccountRows();
  if (state.drawerUid === account.uid && drawer?.open) renderDrawer();
  try {
    const check = await request(accountPath(account.uid, "check"), { method: "POST" });
    const current = state.accounts.find((item) => item.uid === account.uid);
    if (current) current.check = check;
    if (!quiet) toast(check.state === "ok" ? `${account.name} 的会话有效${check.usageError ? "，额度暂无法查询" : ""}` : check.message || "账号检测未通过。", check.state !== "ok");
    return check.state === "ok";
  } catch (error) { if (!quiet) toast(error.message, true); return false; }
  finally {
    state.checking.delete(account.uid);
    if (state.view === "accounts") renderAccountRows();
    if (state.drawerUid === account.uid && drawer?.open) renderDrawer();
  }
}
async function checkAll() {
  if (state.checkingAll) return;
  const queue = state.accounts.filter((account) => account.enabled && !state.checking.has(account.uid));
  if (!queue.length) return;
  state.checkingAll = true;
  renderAccounts();
  let next = 0, success = 0;
  async function worker() {
    while (next < queue.length) { const account = queue[next++]; if (await checkAccount(account, { quiet: true })) success++; }
  }
  try {
    await Promise.all([worker(), worker()]);
    toast(`已检测 ${queue.length} 个账号，${success} 个会话有效`, success !== queue.length);
    await refresh();
  } catch (error) { toast(error.message, true); }
  finally { state.checkingAll = false; if (state.view === "accounts") renderAccounts(); }
}
async function useAccount(account) {
  try {
    await request(accountPath(account.uid, "default"), { method: "POST" });
    await refresh();
    if (drawer?.open) renderDrawer();
    toast(`已将 ${account.name} 设为默认账号${state.gateway.fixedAccountId ? "，固定账号配置仍优先" : ""}`);
  } catch (error) { toast(error.message, true); }
}
function dialog(title, className = "modal") {
  const element = node("dialog", { class: className, "aria-label": title });
  element.append(node("div", { class: "modal-header" }, node("h2", {}, title), iconButton("close", "关闭", () => element.close())));
  element.addEventListener("click", (event) => {
    if (event.target !== element) return;
    const rect = element.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) element.close();
  });
  element.addEventListener("close", () => element.remove(), { once: true });
  document.body.append(element);
  return element;
}
function openDrawer(account) {
  if (drawer?.open) drawer.close();
  state.drawerUid = account.uid;
  drawerDraft = account.name;
  drawer = dialog("账号管理", "drawer");
  const thisDrawer = drawer;
  drawer.addEventListener("close", () => { if (drawer === thisDrawer) { state.drawerUid = null; drawer = null; } }, { once: true });
  renderDrawer();
  drawer.showModal();
}
function renderDrawer() {
  const account = state.accounts.find((item) => item.uid === state.drawerUid);
  if (!account) { drawer?.close(); return; }
  drawer.querySelector(".drawer-content")?.remove();
  const input = node("input", { class: "text-input", type: "text", id: "account-name", value: drawerDraft, required: true, maxlength: 80, onInput: (event) => { drawerDraft = event.target.value; } });
  const form = node("form", { class: "drawer-form", onSubmit: async (event) => {
    event.preventDefault();
    const submit = form.querySelector("button");
    submit.disabled = true;
    try { await request(accountPath(account.uid), { method: "PATCH", body: { name: input.value } }); drawerDraft = input.value.trim(); await refresh(); renderDrawer(); toast("账号名称已保存"); }
    catch (error) { toast(error.message, true); submit.disabled = false; }
  } }, node("label", { class: "field-label", for: "account-name" }, "账号名称"), input, button("保存名称", { type: "submit" }));
  const toggle = node("button", { class: "switch", type: "button", role: "switch", "aria-label": `启用 ${account.name}`, "aria-checked": String(account.enabled), onClick: async () => {
    toggle.disabled = true;
    try { await request(accountPath(account.uid), { method: "PATCH", body: { enabled: !account.enabled } }); await refresh(); renderDrawer(); toast(account.enabled ? "账号已停用" : "账号已启用"); }
    catch (error) { toast(error.message, true); toggle.disabled = false; }
  } });
  drawer.append(node("div", { class: "drawer-content" },
    node("div", { class: "drawer-identity" }, node("span", { class: `account-avatar ${avatarTone(account.uid || account.name)}` }, (account.name || "豆").slice(0, 1)), node("div", {}, node("strong", {}, account.name), node("small", { class: "mono muted" }, account.uid))),
    form,
    node("div", { class: "toggle-line" }, node("div", {}, node("strong", {}, "启用账号"), node("small", {}, "停用后不再用于后续网关请求")), toggle),
    drawerSessionSection(account), drawerCheckinSection(account), drawerQuotaSection(account),
    node("section", { class: "drawer-section drawer-actions" }, button(account.default ? "当前默认账号" : "设为默认账号", { symbol: "star", disabled: account.default || !account.enabled, onClick: () => void useAccount(account) }), button("重新登录 / 更新会话", { symbol: "browser", onClick: () => { drawer.close(); openLogin(); } }), button("移除账号", { kind: "danger", symbol: "trash", onClick: () => removeAccount(account) })),
  ));
}
function drawerSessionSection(account) {
  const [label, kind] = statusMeta[account.check.state] || statusMeta.unchecked;
  return node("section", { class: "drawer-section", id: "drawer-session" }, node("h3", {}, "登录会话"), node("div", { class: "drawer-status-line" }, statusPill(label, kind), button("检测", { kind: "quiet", symbol: "refresh", disabled: state.checking.has(account.uid), onClick: () => void checkAccount(account) })), account.check.message && node("p", { class: "drawer-message" }, account.check.message), node("p", { class: "field-hint" }, account.check.checkedAt ? `最近检测：${formatDate(account.check.checkedAt, true)}` : "尚未检测。点击检测以核验会话并查询额度。"));
}
function drawerCheckinSection(account) {
  const pending = ["queued", "running"].includes(account.checkin?.outcome);
  return node("section", { class: "drawer-section", id: "drawer-checkin" },
    node("div", { class: "drawer-status-line" }, node("h3", {}, "每日签到"), button(pending ? "签到进行中" : "签到领取", { kind: "quiet", symbol: "gift", disabled: state.checkinStarting || state.checkin.active, onClick: () => void startCheckin(account) })),
    checkinBlock(account.checkin), node("p", { class: "field-hint" }, "一键签到只处理已启用账号；此按钮可为当前账号单独签到。"),
  );
}
function drawerQuotaSection(account) {
  return node("section", { class: "drawer-section", id: "drawer-quota" }, node("h3", {}, "使用额度", account.check.usage?.plan && node("small", { class: "muted" }, ` · ${account.check.usage.plan}`)), quotaBlock(account.check));
}
function renderDrawerStatus() {
  const account = state.accounts.find((item) => item.uid === state.drawerUid);
  if (!account) { drawer?.close(); return; }
  drawer?.querySelector("#drawer-session")?.replaceWith(drawerSessionSection(account));
  drawer?.querySelector("#drawer-checkin")?.replaceWith(drawerCheckinSection(account));
  drawer?.querySelector("#drawer-quota")?.replaceWith(drawerQuotaSection(account));
}
function removeAccount(account) {
  const confirmation = dialog("移除账号");
  const remove = button("确认移除", { kind: "danger", onClick: async () => {
    remove.disabled = true;
    try { await request(accountPath(account.uid), { method: "DELETE" }); confirmation.close(); drawer?.close(); await refresh(); toast("账号已从本机账号池移除"); }
    catch (error) { toast(error.message, true); remove.disabled = false; }
  } });
  confirmation.append(node("div", { class: "modal-body" }, node("p", { class: "delete-description" }, "确认从本机账号池移除 ", node("strong", {}, account.name), "？", node("br"), "移除后需要重新登录才能再次使用。", account.default && "其他已启用账号将成为默认账号。"), node("div", { class: "modal-actions" }, button("取消", { onClick: () => confirmation.close() }), remove)));
  confirmation.showModal();
}

function openLogin() {
  if (loginDialog?.open) { loginDialog.focus(); return; }
  loginMode = state.login.active ? "flow" : "form";
  loginDialog = dialog("添加账号");
  const current = loginDialog;
  current.addEventListener("close", () => { if (loginDialog === current) loginDialog = null; }, { once: true });
  renderLogin();
  loginDialog.showModal();
  scheduleLogin();
}
function renderLogin() {
  if (!loginDialog) return;
  loginDialog.querySelector(".modal-body")?.remove();
  if (loginMode === "form" && !state.login.active) {
    const browser = node("select", { id: "login-browser" }, [["auto", "自动选择浏览器"], ["edge", "Microsoft Edge"], ["chrome", "Google Chrome"], ["doubao", "豆包内置浏览器"], ["chromium", "Chromium"]].map(([value, label]) => node("option", { value }, label)));
    const transport = node("select", { id: "login-transport" }, node("option", { value: "pipe" }, "管道连接（推荐）"), node("option", { value: "port" }, "本机回环端口（兼容模式）"));
    const form = node("form", { onSubmit: async (event) => {
      event.preventDefault();
      const options = { browser: browser.value, transport: transport.value };
      loginMode = "flow";
      state.login = { state: "starting", active: true };
      renderLogin();
      try { acceptLogin(await request("/api/login", { method: "POST", body: options })); renderView(); scheduleLogin(); }
      catch (error) { state.login = { state: "error", active: false, message: error.message }; renderLogin(); }
    } }, node("p", { class: "modal-description" }, "选择浏览器后，将打开一个独立登录窗口。完成豆包工作登录，再回到管理台确认接入。同一账号重新登录会更新已有会话。"), node("div", { class: "field-group" }, node("label", { class: "field-label", for: "login-browser" }, "登录浏览器"), browser), node("div", { class: "field-group" }, node("label", { class: "field-label", for: "login-transport" }, "连接方式"), transport), node("div", { class: "modal-actions" }, button("取消", { onClick: () => loginDialog.close() }), button("打开登录窗口", { kind: "primary", symbol: "browser", type: "submit" })));
    loginDialog.append(node("div", { class: "modal-body" }, form));
    return;
  }
  const login = state.login;
  const success = login.state === "success";
  const failed = ["error", "cancelled", "expired"].includes(login.state);
  const titles = { starting: "正在打开独立浏览器", waiting: "等待你完成登录", awaiting_confirmation: "登录完成，请确认接入", importing: "正在核验账号", success: "账号已接入", cancelled: "登录已取消", expired: "登录已超时", error: "登录需要检查" };
  const status = node("div", { class: `login-status login-${login.state}${failed ? " error" : ""}` }, icon(success ? "check" : failed ? "alert" : "browser", 23), node("div", {}, node("strong", {}, titles[login.state] || "正在读取登录状态"), node("p", {}, login.message || "请在新打开的独立浏览器中完成扫码或验证码登录。")));
  const confirm = button(login.state === "importing" ? "正在核验" : "确认接入", { kind: "primary", disabled: login.state !== "awaiting_confirmation", onClick: async () => {
    confirm.disabled = true;
    try { acceptLogin(await request("/api/login/confirm", { method: "POST" })); scheduleLogin(); }
    catch (error) { toast(error.message, true); confirm.disabled = false; }
  } });
  const cancel = button("取消登录", { disabled: login.state === "importing", onClick: async () => {
    cancel.disabled = true;
    try { acceptLogin(await request("/api/login/cancel", { method: "POST" })); renderView(); }
    catch (error) { toast(error.message, true); cancel.disabled = false; }
  } });
  loginDialog.append(node("div", { class: "modal-body" }, status,
    login.active && node("div", { class: "login-steps" }, node("div", { class: "login-step" }, node("span", { class: "step-number" }, "1"), "在独立浏览器完成豆包工作登录及官网验证。"), node("div", { class: "login-step" }, node("span", { class: "step-number" }, "2"), "返回此处点击“确认接入”，账号将自动加入账号池。")),
    login.url && node("a", { class: "login-link", href: login.url, target: "_blank", rel: "noopener noreferrer" }, "打开登录确认页", icon("external", 13)),
    login.active && node("p", { class: "field-hint" }, "可以关闭此弹窗，登录会在后台继续。"),
    node("div", { class: "modal-actions" }, login.active ? [cancel, confirm] : [!success && button("重新尝试", { onClick: () => { loginMode = "form"; renderLogin(); } }), button(success ? "完成" : "关闭", { kind: success ? "primary" : "secondary", onClick: () => loginDialog.close() })]),
  ));
}
function acceptLogin(login) {
  if (!login) return;
  const previous = state.login;
  state.login = login;
  if (JSON.stringify(previous) !== JSON.stringify(login)) renderLogin();
  if (login.state === "success" && previous.id === login.id && previous.state !== "success") {
    toast(login.message || "账号已接入");
    if (!refreshTask) void refresh().catch(() => {});
  }
  scheduleLogin();
}
function scheduleLogin() {
  if (loginTimer || !state.login.active) return;
  loginTimer = setTimeout(async () => {
    loginTimer = null;
    try { acceptLogin(await request("/api/login")); if (!state.login.active) await refresh(); }
    catch (error) { toast(error.message, true); }
    scheduleLogin();
  }, 1200);
}

async function loadModels(uid = state.modelUid) {
  if (!uid) return;
  state.modelUid = uid;
  const generation = ++modelRequest;
  state.modelLoading = true;
  state.modelError = "";
  state.models = [];
  if (state.view === "models") renderModels();
  try {
    const result = await request(accountPath(uid, "models"));
    if (generation === modelRequest) state.models = result.models;
  } catch (error) { if (generation === modelRequest) state.modelError = error.message; }
  finally { if (generation === modelRequest) { state.modelLoading = false; if (state.view === "models") renderModels(); } }
}
function renderModels() {
  if (!state.accounts.some((account) => account.uid === state.modelUid)) { state.modelUid = (state.accounts.find((account) => account.default) || state.accounts[0])?.uid || ""; state.models = []; }
  const selector = node("select", { id: "model-account", "aria-label": "查看账号", onChange: (event) => void loadModels(event.target.value) }, state.accounts.map((account) => node("option", { value: account.uid }, `${account.name}${account.enabled ? "" : "（已停用）"}`)));
  selector.value = state.modelUid;
  content.replaceChildren(pageHeading("模型目录", "查看各账号实际可用的模型，复制模型 ID 用于客户端配置。", button(state.modelLoading ? "正在查询" : "刷新模型", { symbol: "refresh", className: state.modelLoading ? "spinner" : "", disabled: state.modelLoading || !state.modelUid, onClick: () => void loadModels() })), ...banners(),
    ...(!state.accounts.length ? [node("div", { class: "panel" }, emptyState("先接入一个账号", "模型目录来自账号的实际权限，添加账号后即可查询。", button("添加账号", { kind: "primary", symbol: "plus", onClick: openLogin }), "layers"))] : [
      node("div", { class: "model-toolbar" }, node("label", { class: "field-inline", for: "model-account" }, "查看账号", selector), searchField("搜索模型名称或 ID", state.modelSearch, (event) => { state.modelSearch = event.target.value; renderModelRows(); })),
      node("section", { class: "pool-panel" }, node("div", { class: "table-scroll", id: "model-table-wrap" }, node("table", { class: "model-table", "aria-label": "可用模型" }, node("thead", {}, node("tr", {}, ["模型名称", "模型 ID", "提供方", "操作"].map((title) => node("th", { scope: "col" }, title)))), node("tbody", { id: "model-rows" }))), node("div", { id: "model-empty" }), node("div", { class: "pool-footer" }, node("span", { id: "model-count" }), "按当前账号权限查询")),
    ]),
  );
  renderModelRows();
}
function renderModelRows() {
  const rows = document.getElementById("model-rows");
  if (!rows) return;
  const query = state.modelSearch.trim().toLowerCase();
  const models = state.models.filter((model) => `${model.name} ${model.id}`.toLowerCase().includes(query));
  rows.replaceChildren(...models.map((model) => node("tr", {}, node("td", {}, node("strong", {}, model.name || model.id)), node("td", {}, node("code", { class: "mono" }, model.id)), node("td", { class: "muted" }, "豆包工作"), node("td", {}, button("复制 ID", { kind: "quiet", symbol: "copy", onClick: () => void copy(model.id, "模型 ID") })))));
  document.getElementById("model-table-wrap").hidden = state.modelLoading || !models.length || Boolean(state.modelError);
  const empty = document.getElementById("model-empty");
  empty.replaceChildren();
  if (state.modelLoading) empty.append(node("div", { class: "initial-loading" }, "正在查询账号的模型目录…"));
  else if (state.modelError) empty.append(emptyState("模型查询未完成", state.modelError, button("重新查询", { symbol: "refresh", onClick: () => void loadModels() }), "alert"));
  else if (!models.length) empty.append(emptyState(state.models.length ? "没有匹配的模型" : "暂无可用模型", state.models.length ? "试试其他模型名称或 ID。" : "点击刷新模型，查询该账号的实际模型权限。", button(state.models.length ? "清空搜索" : "刷新模型", { onClick: () => { if (state.models.length) { state.modelSearch = ""; renderModels(); } else void loadModels(); } }), "layers"));
  document.getElementById("model-count").textContent = `共 ${models.length} 个可用模型`;
}
async function loadSettings() {
  try { state.settings = await request("/api/settings"); if (state.view === "settings") renderSettings(); }
  catch (error) { toast(error.message, true); }
}
async function revealKey() {
  const result = await request("/api/key", { method: "POST" });
  return result.apiKey;
}
function renderSettings() {
  if (!state.settings) { content.replaceChildren(pageHeading("接入配置", "将网关地址与访问密钥填入你的客户端。"), ...banners(), node("div", { class: "panel" }, emptyState("读取接入配置", "配置来自当前管理台使用的网关设置。", button("读取配置", { onClick: () => void loadSettings(), symbol: "refresh" }), "settings"))); return; }
  const config = state.settings;
  const protocols = config.protocols || [{ id: "chat", name: "OpenAI · Chat Completions", baseUrl: config.baseUrl, path: "/v1/chat/completions" }];
  const protocol = protocols.find((item) => item.id === state.clientProtocol) || protocols[0];
  const protocolSelect = node("select", { id: "client-protocol", onChange: (event) => { state.clientProtocol = event.target.value; renderSettings(); } }, protocols.map((item) => node("option", { value: item.id, selected: item.id === protocol.id }, item.name)));
  const endpoint = node("input", { class: "text-input mono", id: "base-url", type: "text", readonly: true, value: protocol.baseUrl });
  const keyInput = node("input", { class: "text-input mono", id: "api-key", type: state.apiKey ? "text" : "password", readonly: true, value: state.apiKey, placeholder: "点击显示以查看访问密钥", autocomplete: "off" });
  const reveal = button(state.apiKey ? "隐藏" : "显示", { onClick: async () => {
    reveal.disabled = true;
    try { state.apiKey = state.apiKey ? "" : await revealKey(); renderSettings(); }
    catch (error) { toast(error.message, true); reveal.disabled = false; }
  } });
  const keyCopy = button("复制密钥", { symbol: "copy", onClick: async () => {
    keyCopy.disabled = true;
    try { await copy(state.apiKey || await revealKey(), "API Key"); }
    catch (error) { toast(error.message, true); }
    finally { keyCopy.disabled = false; }
  } });
  const settings = [
    ["管理台端口", config.adminPort], ["支持协议", protocols.map((item) => item.name).join(" / ")], ["账号策略", config.fixedAccountId ? "固定指定账号" : "默认账号"],
    ["请求超时", `${config.timeoutMs / 1000} 秒`], ["单账号并发", `${config.maxConcurrency} 个对话`], ["实验性工具桥", config.promptTools ? "已启用" : "已关闭"],
    ["上游历史", config.hideHistory ? "会话完成后自动隐藏" : "保留会话记录"],
    ...(config.hideHistory && config.historyCleanup ? [["已隐藏会话", config.historyCleanup.hidden], ["隐藏未完成", config.historyCleanup.failed]] : []),
    ...(config.fixedAccountId ? [["固定账号 UID", config.fixedAccountId]] : []), ["数据目录", config.dataDir],
  ];
  content.replaceChildren(pageHeading("接入配置", "将网关地址与访问密钥填入你的客户端。", button("刷新配置", { symbol: "refresh", onClick: () => void loadSettings() })), ...banners(), node("div", { class: "settings-grid" },
    node("section", { class: "panel" }, node("div", { class: "panel-heading" }, node("div", {}, node("h2", {}, "客户端接入"), node("p", {}, "客户端与网关使用同一组地址和密钥。")), icon("key", 20)), node("div", { class: "settings-body" },
      node("div", { class: "field-group" }, node("label", { class: "field-label", for: "client-protocol" }, "接口协议"), protocolSelect, node("p", { class: "field-hint" }, protocol.id === "claude" ? "Claude 的 token 数为本地估算，不代表豆包实际计量。" : "在客户端选择相同的协议，并使用模型目录中的实际模型 ID。")),
      node("div", { class: "field-group" }, node("label", { class: "field-label", for: "base-url" }, "Base URL / API 地址"), node("div", { class: "input-actions" }, endpoint, button("复制地址", { symbol: "copy", onClick: () => void copy(protocol.baseUrl, "网关地址") })), node("p", { class: "field-hint" }, `请求路径为 ${protocol.path}，客户端通常会自动追加接口路径。`)),
      node("div", { class: "field-group" }, node("label", { class: "field-label", for: "api-key" }, "API Key / 访问密钥"), node("div", { class: "input-actions" }, keyInput, reveal, keyCopy), node("p", { class: "field-hint" }, "API Key 用于客户端访问网关，账号登录凭据仅保存在本机。")),
      node("p", { class: "settings-footnote" }, "模型 ID 可在“模型目录”中查询。其他设备访问时，请使用网关机器可达的地址。"),
    )),
    node("section", { class: "panel" }, node("div", { class: "panel-heading" }, node("div", {}, node("h2", {}, "运行配置"), node("p", {}, "来自当前启动配置。")), icon("settings", 20)), node("div", { class: "settings-body" }, node("dl", { class: "settings-list" }, settings.map(([label, value]) => node("div", {}, node("dt", {}, label), node("dd", {}, String(value))))), config.hideHistory && node("p", { class: "settings-footnote" }, "生成期间记录可能短暂出现。收到会话编号后，完成、取消或超时都会自动隐藏这次上游会话；清理失败会计入“隐藏未完成”。"), node("p", { class: "settings-footnote" }, "账号切换和启停对后续请求生效。端口、密钥等配置在 .env 中修改，重启服务后生效。"))),
  ));
}

for (const element of document.querySelectorAll("[data-icon]")) element.replaceChildren(icon(element.dataset.icon, 18));
document.getElementById("local-address").textContent = location.host;
document.getElementById("navigation").addEventListener("click", (event) => {
  const target = event.target.closest("[data-view]");
  if (!target) return;
  state.apiKey = "";
  state.view = target.dataset.view;
  renderView();
  if (state.view === "models" && state.modelUid && !state.modelLoading) void loadModels();
  if (state.view === "settings") void loadSettings();
});
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") { state.apiKey = ""; if (state.view === "settings") renderSettings(); } else void refresh().catch(() => {}); });
async function boot() {
  try { await session(); await refresh(); }
  catch (error) { content.replaceChildren(node("div", { class: "panel boot-error" }, emptyState("无法读取账号池", error.message, button("重新连接", { kind: "primary", symbol: "refresh", onClick: () => void boot() }), "alert"))); }
}
void boot();
setInterval(() => { if (document.visibilityState === "visible" && state.token) void refresh().catch(() => {}); }, 15000);
