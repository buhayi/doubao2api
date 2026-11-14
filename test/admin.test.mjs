// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { dirname, basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createAdmin } from "../gateway/admin.mjs";
import { createStore } from "../gateway/store.mjs";
import { createGateway } from "../gateway/server.mjs";
import { loadConfig } from "../gateway/config.mjs";
import { runCli } from "../gateway/cli.mjs";
import { saveAuth, fail } from "../protocol.mjs";

const KEY = "ADMIN_TEST_KEY";
const auth = (id) => saveAuth({ cookieHeader: `sessionid=PRIVATE_COOKIE_${id}`, userId: id, enterpriseType: "0", name: `测试账号-${id}` });
const makeStore = (root) => createStore(root, { secureRoot: (path) => mkdir(path, { recursive: true, mode: 0o700 }) });
function rawStatus(url, headers) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { headers }, (res) => { res.resume(); res.once("end", () => resolve(res.statusCode)); });
    req.on("error", reject);
    req.end();
  });
}
async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), "dw-admin-test-"));
  assert.equal(dirname(resolve(root)), resolve(tmpdir()));
  assert(basename(root).startsWith("dw-admin-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function fixture(t, options = {}) {
  const root = await directory(t);
  const store = makeStore(root);
  await store.save(auth("a"));
  await store.save(auth("b"));
  const api = {
    identify: async (secret) => ({ ...secret, name: "已核验" }),
    usage: async () => ({ plan: "个人版", windows: [{ name: "5 小时", used: 23, cookieHeader: "PRIVATE_USAGE_COOKIE" }], secret: "PRIVATE_USAGE_SECRET" }),
    catalog: async (secret) => ({ models: { flash: { id: `flash-${secret.userId}`, name: "Flash", cookieHeader: "PRIVATE_MODEL_COOKIE" } } }),
    ...options.api,
  };
  const admin = createAdmin({ store, api, apiKey: KEY, config: { host: "127.0.0.1", port: 8787, ...options.config }, health: () => true, ...options, api });
  t.after(() => admin.close());
  admin.server.listen(0, "127.0.0.1");
  await once(admin.server, "listening");
  const url = `http://127.0.0.1:${admin.server.address().port}`;
  const { token } = await (await fetch(url + "/api/session")).json();
  const call = (path, { method = "GET", body, headers, ...rest } = {}) => fetch(url + path, { method, headers: { "X-Doubao-Admin": token, ...(method === "GET" ? {} : { Origin: url, "Content-Type": "application/json" }), ...headers }, ...(method === "GET" ? {} : { body: typeof body === "string" ? body : JSON.stringify(body || {}) }), ...rest });
  return { root, store, api, admin, url, token, call };
}

test("管理台配置：默认 8786、可禁用、拒绝非法或重复端口", async (t) => {
  const cwd = await directory(t);
  assert.equal((await loadConfig({ cwd, env: {} })).adminPort, 8786);
  assert.equal((await loadConfig({ cwd, env: { DW_ADMIN_PORT: "0" } })).adminPort, 0);
  for (const value of ["-1", "65536", "8.1", "8787"])
    await assert.rejects(loadConfig({ cwd, env: { DW_ADMIN_PORT: value } }));
});

test("管理台：静态资源可用，Host / 来源 / 令牌验证阻止跨站管理", async (t) => {
  const f = await fixture(t);
  const page = await fetch(f.url);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.match(await page.text(), /账号池管理台/);
  assert.equal(await rawStatus(f.url + "/", { "Sec-Fetch-Site": "cross-site" }), 200);
  for (const path of ["/app.mjs", "/ui.mjs", "/style.css", "/avatar.png"]) assert.equal((await fetch(f.url + path)).status, 200);
  for (const path of ["/data/accounts.json", "/gateway/store.mjs", "/../.env"]) assert.equal((await fetch(f.url + path)).status, 404);
  assert.equal((await fetch(f.url + "/api/overview")).status, 403);
  assert.equal((await f.call("/api/overview", { headers: { "X-Doubao-Admin": "wrong" } })).status, 403);
  assert.equal(await rawStatus(f.url + "/api/overview", { Host: "evil.example", "X-Doubao-Admin": f.token }), 403);
  assert.equal((await fetch(f.url + "/api/session", { headers: { Origin: "https://evil.example" } })).status, 403);
  assert.equal(await rawStatus(f.url + "/api/session", { "Sec-Fetch-Site": "cross-site" }), 403);
  assert.equal((await f.call("/api/accounts/a%3A0", { method: "PATCH", body: { enabled: false }, headers: { Origin: "http://localhost:9999" } })).status, 403);
  assert.equal((await fetch(f.url + "/api/key", { method: "POST", headers: { "X-Doubao-Admin": f.token, "Content-Type": "application/json" }, body: "{}" })).status, 403);
  assert.equal((await f.store.list()).filter((account) => account.enabled).length, 2);
});

test("管理台：真实账号列表、重命名、启停、默认切换和移除持久化且无凭据", async (t) => {
  const f = await fixture(t);
  const result = await (await f.call("/api/overview")).json();
  assert.equal(result.accounts.length, 2);
  assert.equal(result.accounts[0].check.state, "unchecked");
  assert.equal(result.gateway.online, true);
  assert(!JSON.stringify(result).includes("PRIVATE_"));
  assert.equal((await f.call("/api/accounts/a%3A0", { method: "PATCH", body: { name: "工作账号", enabled: false } })).status, 200);
  assert.equal((await makeStore(f.root).account()).uid, "b:0");
  assert.equal((await makeStore(f.root).list())[0].name, "工作账号");
  await assert.rejects(makeStore(f.root).account("a:0"), (error) => error.status === 503);
  assert.equal((await f.call("/api/accounts/a%3A0/default", { method: "POST" })).status, 409);
  assert.equal((await f.call("/api/accounts/b%3A0", { method: "PATCH", body: { enabled: false } })).status, 200);
  await assert.rejects(makeStore(f.root).account(), /所有账号已停用/);
  assert.equal((await f.call("/api/accounts/a%3A0", { method: "PATCH", body: { enabled: true } })).status, 200);
  assert.equal((await makeStore(f.root).account()).uid, "a:0");
  assert.equal((await f.call("/api/accounts/a%3A0", { method: "DELETE" })).status, 200);
  assert.equal((await f.store.list()).length, 1);
  await assert.rejects(f.store.account(), /所有账号已停用/);
  assert.equal((await f.call("/api/accounts/missing", { method: "DELETE" })).status, 404);
});

test("账号启停：网关后续请求热读取，同一账号重登保留停用状态", async (t) => {
  const f = await fixture(t);
  const gateway = createGateway({ store: f.store, api: f.api, apiKey: KEY, accountId: "a:0" });
  t.after(() => gateway.close());
  gateway.server.listen(0, "127.0.0.1");
  await once(gateway.server, "listening");
  const url = `http://127.0.0.1:${gateway.server.address().port}/v1/models`;
  const models = () => fetch(url, { headers: { Authorization: `Bearer ${KEY}` } });
  assert.equal((await models()).status, 200);
  await f.store.update("a:0", { enabled: false });
  assert.equal((await models()).status, 503);
  await f.store.save(auth("a"));
  assert.equal((await f.store.list()).find((account) => account.uid === "a:0").enabled, false);
  assert.equal((await models()).status, 503);
  await f.store.update("a:0", { enabled: true });
  assert.equal((await models()).status, 200);
});

test("管理台：账号核验、真实额度和模型只返回公开字段", async (t) => {
  const f = await fixture(t);
  await f.store.update("a:0", { enabled: false });
  const check = await (await f.call("/api/accounts/a%3A0/check", { method: "POST" })).json();
  assert.equal(check.state, "ok");
  assert.equal(check.usage.windows[0].used, 23);
  assert(!JSON.stringify(check).includes("PRIVATE_"));
  const models = await (await f.call("/api/accounts/b%3A0/models")).json();
  assert.deepEqual(models, { models: [{ id: "flash-b", name: "Flash" }] });
  const list = await (await f.call("/api/overview")).json();
  assert.equal(list.accounts[0].check.state, "ok");
  assert(!JSON.stringify(list).includes("PRIVATE_"));
  await f.store.save(auth("a"));
  assert.equal((await (await f.call("/api/overview")).json()).accounts[0].check.state, "unchecked");
});

test("管理台：失效会话和未知上游错误正确呈现，不泄露异常中的凭据", async (t) => {
  const f = await fixture(t, { api: { identify: async (secret) => {
    if (secret.userId === "a") throw Object.assign(fail(401, "会话已失效，请重新登录。"), { reason: "session_expired" });
    throw Error("PRIVATE_EXCEPTION_COOKIE");
  } } });
  const expired = await (await f.call("/api/accounts/a%3A0/check", { method: "POST" })).json();
  assert.equal(expired.state, "expired");
  const broken = await (await f.call("/api/accounts/b%3A0/check", { method: "POST" })).json();
  assert.equal(broken.state, "error");
  assert(!JSON.stringify(broken).includes("PRIVATE_"));
});

test("管理台：正文和修改字段校验失败时不改变已有账号", async (t) => {
  const f = await fixture(t);
  const file = join(f.root, "accounts.json");
  const before = await readFile(file, "utf8");
  for (const value of [{}, { auth: "invalid" }, { enabled: "false" }, { name: " " }, { name: "x".repeat(81) }, { name: "a\nb" }])
    assert.equal((await f.call("/api/accounts/a%3A0", { method: "PATCH", body: value })).status, 400);
  assert.equal((await f.call("/api/accounts/a%3A0", { method: "PATCH", body: "{" })).status, 400);
  assert.equal((await f.call("/api/accounts/a%3A0", { method: "PATCH", body: "[]" })).status, 400);
  assert.equal((await f.call("/api/accounts/a%3A0", { method: "PATCH", body: { name: "x".repeat(9000) } })).status, 413);
  assert.equal((await f.call("/api/accounts/a%3A0", { method: "PATCH", headers: { "Content-Type": "text/plain" } })).status, 415);
  assert.equal((await f.call("/api/accounts/a%3A0/default")).status, 405);
  const oversized = await new Promise((resolve, reject) => {
    const req = httpRequest(f.url + "/api/accounts/a%3A0", { method: "PATCH", headers: { Origin: f.url, "Content-Type": "application/json", "X-Doubao-Admin": f.token } }, (res) => { res.resume(); res.once("end", () => resolve(res.statusCode)); });
    req.on("error", reject);
    for (let index = 0; index < 16; index++) req.write("x".repeat(1024));
    req.end();
  });
  assert.equal(oversized, 413);
  assert.equal(await readFile(file, "utf8"), before);
});

const dailyCampaign = (checked) => ({ data: {
  campaign_code: "pc_incentive_task_mvp_v3",
  tasks: [{ campaign_code: "daily", reward_mode: 2, task_status: 1, daily_checkin: { checked_in_today: checked, reward: { reward_amount: 200 }, continuous_days: checked ? 3 : 2 } }],
} });
const launchCampaign = { data: { ug_campaign_info: { campaign_group_code: "pc_incentive_task_mvp_v3" } } };
async function waitCheckin(f) {
  const deadline = Date.now() + 5000;
  let status;
  do {
    status = await (await f.call("/api/checkin")).json();
    if (!status.active) return status;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  assert.fail("签到任务没有在测试期限内完成");
}
async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("未观察到预期的后台操作");
}
function claimFixture() {
  const checked = new Set(), claims = [], queries = [];
  return { checked, claims, queries, post: async (secret, path) => {
    queries.push([secret.userId, path]);
    if (path.endsWith("/launch")) return launchCampaign;
    if (path.endsWith("/claim/")) { claims.push(secret.userId); checked.add(secret.userId); return { code: 0 }; }
    return dailyCampaign(checked.has(secret.userId));
  } };
}

test("签到接口：查询无副作用，领取要求令牌、同源 JSON 和正确方法", async (t) => {
  const signing = claimFixture();
  const f = await fixture(t, { api: { post: signing.post } });
  assert.equal((await (await f.call("/api/checkin")).json()).state, "idle");
  assert.equal((await (await f.call("/api/overview")).json()).accounts[0].checkin.outcome, "unchecked");
  assert.equal((await f.call("/api/accounts/a%3A0/checkin")).status, 405);
  const wrongMethod = await f.call("/api/checkin", { method: "DELETE" });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "GET, POST");
  assert.equal((await f.call("/api/checkin", { method: "POST", headers: { "X-Doubao-Admin": "wrong" } })).status, 403);
  assert.equal((await f.call("/api/accounts/a%3A0/checkin", { method: "POST", headers: { Origin: "https://evil.example" } })).status, 403);
  assert.equal((await f.call("/api/checkin", { method: "POST", headers: { "Content-Type": "text/plain" } })).status, 415);
  assert.equal((await f.call("/api/checkin", { method: "POST", body: "{" })).status, 400);
  assert.equal((await f.call("/api/accounts/missing/checkin", { method: "POST" })).status, 404);
  await f.store.update("a:0", { enabled: false });
  await f.store.update("b:0", { enabled: false });
  assert.equal((await f.call("/api/checkin", { method: "POST" })).status, 409);
  assert.deepEqual(signing.queries, []);
});

test("单账号签到：后台领取并回查，刷新公开额度，重复操作只查询", async (t) => {
  const signing = claimFixture();
  let usageCalls = 0;
  const f = await fixture(t, { api: { post: signing.post, usage: async () => {
    usageCalls++;
    return { plan: "个人版", windows: [{ name: "积分", amount: 20, limit: 220, unit: "额度", cookieHeader: "PRIVATE_USAGE_COOKIE" }] };
  } } });
  const response = await f.call("/api/accounts/a%3A0/checkin", { method: "POST" });
  assert.equal(response.status, 202);
  const started = await response.json();
  assert.equal(started.kind, "single");
  assert.equal(started.total, 1);
  const status = await waitCheckin(f);
  assert.equal(status.state, "completed");
  assert.equal(status.completed, 1);
  assert.equal(status.results[0].outcome, "claimed");
  assert.equal(status.results[0].credit, 200);
  assert.equal(status.results[0].streak, 3);
  assert.equal(status.counts.claimed, 1);
  assert.equal(usageCalls, 1);
  const overview = await (await f.call("/api/overview")).json();
  assert.equal(overview.accounts[0].checkin.outcome, "claimed");
  assert.equal(overview.accounts[0].check.usage.windows[0].limit, 220);
  assert.equal(overview.accounts[1].checkin.outcome, "unchecked");
  assert(!JSON.stringify([status, overview]).includes("PRIVATE_"));
  await f.call("/api/accounts/a%3A0/checkin", { method: "POST" });
  const repeated = await waitCheckin(f);
  assert.equal(repeated.results[0].outcome, "done");
  assert.equal(repeated.results[0].credit, undefined);
  assert.deepEqual(signing.claims, ["a"]);
  assert.equal(usageCalls, 2);
});

test("批量签到：只选启用账号，单个会话失败不阻止后续领取且不泄露凭据", async (t) => {
  const signing = claimFixture();
  const f = await fixture(t, { api: { post: async (secret, path, ...rest) => {
    if (secret.userId === "a") throw fail(401, "PRIVATE_EXCEPTION_COOKIE");
    return signing.post(secret, path, ...rest);
  } } });
  await f.store.save(auth("c"));
  await f.store.update("b:0", { enabled: false });
  const response = await f.call("/api/checkin", { method: "POST" });
  assert.equal(response.status, 202);
  assert.equal((await response.json()).total, 2);
  const status = await waitCheckin(f);
  assert.equal(status.completed, 2);
  assert.equal(status.results[0].outcome, "expired");
  assert.equal(status.results[1].outcome, "claimed");
  assert.equal(status.counts.expired, 1);
  assert.equal(status.counts.claimed, 1);
  assert.deepEqual(signing.claims, ["c"]);
  assert(!JSON.stringify(status).includes("PRIVATE_"));
  assert.equal((await (await f.call("/api/overview")).json()).accounts.find((account) => account.uid === "b:0").checkin.outcome, "unchecked");
});

test("批量签到：排队后停用或移除的账号跳过，重入拒绝，停用账号仍可单独签到", async (t) => {
  const signing = claimFixture();
  let entered = false, release;
  const gate = new Promise((resolve) => { release = resolve; });
  const f = await fixture(t, { api: { post: async (secret, path, ...rest) => {
    if (secret.userId === "a" && path.endsWith("/launch")) { entered = true; await gate; }
    return signing.post(secret, path, ...rest);
  } } });
  t.after(release);
  await f.store.save(auth("c"));
  const response = await f.call("/api/checkin", { method: "POST" });
  assert.equal(response.status, 202);
  await waitUntil(() => entered);
  const progress = await (await f.call("/api/checkin")).json();
  assert.equal(progress.active, true);
  assert.equal(progress.completed, 0);
  assert.equal(progress.current.uid, "a:0");
  assert.equal((await f.call("/api/checkin", { method: "POST" })).status, 409);
  assert.equal((await f.call("/api/accounts/b%3A0/checkin", { method: "POST" })).status, 409);
  await f.store.update("b:0", { enabled: false });
  await f.store.remove("c:0");
  release();
  const status = await waitCheckin(f);
  assert.equal(status.completed, 3);
  assert.equal(status.results[0].outcome, "claimed");
  assert.equal(status.results[1].outcome, "skipped");
  assert.equal(status.results[2].outcome, "skipped");
  assert.deepEqual(signing.claims, ["a"]);
  await f.call("/api/accounts/b%3A0/checkin", { method: "POST" });
  assert.equal((await waitCheckin(f)).results[0].outcome, "claimed");
  assert.deepEqual(signing.claims, ["a", "b"]);
  assert.equal((await f.store.list()).find((account) => account.uid === "b:0").enabled, false);
});

test("签到任务：启动响应关闭后后台继续，状态查询不会再次提交", async (t) => {
  const signing = claimFixture();
  let entered = false, release;
  const gate = new Promise((resolve) => { release = resolve; });
  const f = await fixture(t, { api: { post: async (secret, path, ...rest) => {
    if (path.endsWith("/launch")) { entered = true; await gate; }
    return signing.post(secret, path, ...rest);
  } } });
  t.after(release);
  const controller = new AbortController();
  const response = await f.call("/api/accounts/a%3A0/checkin", { method: "POST", signal: controller.signal });
  assert.equal(response.status, 202);
  await response.json();
  await waitUntil(() => entered);
  controller.abort();
  release();
  assert.equal((await waitCheckin(f)).results[0].outcome, "claimed");
  const before = signing.queries.length;
  await f.call("/api/checkin");
  await f.call("/api/overview");
  assert.equal(signing.queries.length, before);
  assert.deepEqual(signing.claims, ["a"]);
});

test("签到任务：上游未确认时保留提交记录，重复点击不再领取", async (t) => {
  let claims = 0;
  const f = await fixture(t, { api: { post: async (_secret, path) => {
    if (path.endsWith("/launch")) return launchCampaign;
    if (path.endsWith("/claim/")) { claims++; throw Error("PRIVATE_NETWORK_COOKIE"); }
    return dailyCampaign(false);
  } } });
  await f.call("/api/accounts/a%3A0/checkin", { method: "POST" });
  assert.equal((await waitCheckin(f)).results[0].outcome, "failed");
  await f.call("/api/accounts/a%3A0/checkin", { method: "POST" });
  const repeated = await waitCheckin(f);
  assert.equal(repeated.results[0].outcome, "failed");
  assert.equal(claims, 1);
  assert(!JSON.stringify(repeated).includes("PRIVATE_"));
});

test("签到任务：已确认领取不会因额度查询失败变成领取失败", async (t) => {
  const signing = claimFixture();
  const f = await fixture(t, { api: { post: signing.post, usage: async () => { throw Error("PRIVATE_USAGE_COOKIE"); } } });
  await f.call("/api/accounts/a%3A0/checkin", { method: "POST" });
  const status = await waitCheckin(f);
  assert.equal(status.results[0].outcome, "claimed");
  assert.equal(status.results[0].credit, 200);
  assert.match(status.results[0].usageError, /额度/);
  const overview = await (await f.call("/api/overview")).json();
  assert.equal(overview.accounts[0].check.state, "ok");
  assert.equal(overview.accounts[0].check.usage, undefined);
  assert.match(overview.accounts[0].check.usageError, /额度/);
  assert(!JSON.stringify([status, overview]).includes("PRIVATE_"));
});

test("签到额度：签到前的旧检测响应迟到也不会覆盖领取后的额度", async (t) => {
  const signing = claimFixture();
  let usageCalls = 0, entered = false, release;
  const gate = new Promise((resolve) => { release = resolve; });
  const f = await fixture(t, { api: { post: signing.post, usage: async () => {
    if (++usageCalls === 1) { entered = true; await gate; return { windows: [{ name: "积分", amount: 10, limit: 20 }] }; }
    return { windows: [{ name: "积分", amount: 10, limit: 220 }] };
  } } });
  t.after(release);
  const detection = f.call("/api/accounts/a%3A0/check", { method: "POST" });
  await waitUntil(() => entered);
  await f.call("/api/accounts/a%3A0/checkin", { method: "POST" });
  assert.equal((await waitCheckin(f)).results[0].outcome, "claimed");
  release();
  assert.equal((await (await detection).json()).usage.windows[0].limit, 220);
  assert.equal((await (await f.call("/api/overview")).json()).accounts[0].check.usage.windows[0].limit, 220);
});

test("签到任务：单账号超时有结果，批量继续处理后续账号", async (t) => {
  const signing = claimFixture();
  let timedOut = false;
  const f = await fixture(t, { config: { timeoutMs: 250 }, api: { post: async (secret, path, payload, { signal }) => {
    if (secret.userId !== "a") return signing.post(secret, path, payload, { signal });
    return new Promise((_resolve, reject) => {
      const abort = () => { timedOut = true; reject(signal.reason); };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  } } });
  await f.call("/api/checkin", { method: "POST" });
  const status = await waitCheckin(f);
  assert.equal(timedOut, true);
  assert.equal(status.results[0].outcome, "failed");
  assert.match(status.results[0].message, /超时/);
  assert.equal(status.results[1].outcome, "claimed");
  assert.deepEqual(signing.claims, ["b"]);
});

test("签到任务：服务关闭取消上游请求，不执行后续账号", async (t) => {
  const queries = [];
  let receivedSignal;
  const f = await fixture(t, { api: { post: async (secret, _path, _payload, { signal }) => {
    queries.push(secret.userId);
    receivedSignal = signal;
    return new Promise((_resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  } } });
  await f.call("/api/checkin", { method: "POST" });
  await waitUntil(() => receivedSignal);
  await f.admin.close();
  assert.equal(receivedSignal.aborted, true);
  assert.deepEqual(queries, ["a"]);
  assert.equal((await f.store.list()).length, 2);
});

test("管理台：接入配置默认不包含 API Key，密钥需要同源显式操作", async (t) => {
  const f = await fixture(t);
  const config = await (await f.call("/api/settings")).json();
  assert.equal(config.baseUrl, "http://127.0.0.1:8787/v1");
  assert.equal(config.maxConcurrency, 3);
  assert.equal(config.hideHistory, true);
  assert.equal(config.historyCleanup, null);
  assert(!JSON.stringify(config).includes(KEY));
  assert.equal((await f.call("/api/key")).status, 404);
  assert.deepEqual(await (await f.call("/api/key", { method: "POST" })).json(), { apiKey: KEY });
});

test("管理台登录：异步开启、等待本人确认、核验后保存和清理", async (t) => {
  let flowState = "waiting", finish, disposed = 0;
  const f = await fixture(t, { loginFactory: ({ standalone }) => {
    assert.equal(standalone, true);
    return {
      async start({ browserId, transport }) {
        assert.equal(browserId, "edge");
        assert.equal(transport, "pipe");
        return { url: "http://127.0.0.1:1/confirmation/", status: () => ({ state: flowState, active: true }), confirm: async () => { finish(auth("c")); }, callback: () => new Promise((resolve) => { finish = resolve; }) };
      },
      async dispose() { disposed++; },
    };
  } });
  assert.equal((await f.call("/api/login", { method: "POST", body: { browser: "edge" } })).status, 202);
  for (let attempt = 0; attempt < 100 && !finish; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert(finish);
  assert.equal((await f.call("/api/login", { method: "POST" })).status, 409);
  assert.equal((await f.call("/api/login/confirm", { method: "POST" })).status, 409);
  assert.equal((await f.store.list()).length, 2);
  flowState = "awaiting_confirmation";
  assert.equal((await f.call("/api/login/confirm", { method: "POST" })).status, 200);
  let status;
  for (let attempt = 0; attempt < 100; attempt++) { status = await (await f.call("/api/login")).json(); if (!status.active) break; await new Promise((resolve) => setTimeout(resolve, 5)); }
  assert.equal(status.state, "success");
  assert.equal(status.result.uid, "c:0");
  assert(!JSON.stringify(status).includes("PRIVATE_"));
  assert.equal((await f.store.list()).length, 3);
  assert.equal(disposed, 1);
});

test("管理台登录：取消不会保存账号，后台登录也随服务关闭清理", async (t) => {
  let started = 0, disposed = 0;
  const f = await fixture(t, { loginFactory: () => ({
    async start() {
      started++;
      return { url: "http://127.0.0.1:1/", callback: (_code, { signal }) => new Promise((resolve) => {
        const finish = () => resolve(auth("cancelled"));
        signal.addEventListener("abort", finish, { once: true });
        if (signal.aborted) finish();
      }) };
    },
    async dispose() { disposed++; },
  }) });
  await f.call("/api/login", { method: "POST" });
  for (let attempt = 0; attempt < 100 && started < 1; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  const status = await (await f.call("/api/login/cancel", { method: "POST" })).json();
  assert.equal(status.state, "cancelled");
  assert.equal((await f.store.list()).length, 2);
  await f.call("/api/login", { method: "POST" });
  for (let attempt = 0; attempt < 100 && started < 2; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  await f.admin.close();
  assert.equal(disposed, 2);
  assert.equal((await f.store.list()).length, 2);
});

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
test("CLI：同时启动网关及管理台，信号关闭两个监听且日志不暴露密钥", async (t) => {
  const cwd = await directory(t);
  const port = await freePort();
  let adminPort = await freePort();
  while (adminPort === port) adminPort = await freePort();
  const signals = new EventEmitter();
  const output = [];
  let notify;
  const ready = new Promise((resolve) => { notify = resolve; });
  const serving = runCli({ cwd, argv: ["serve"], env: { DW_PORT: String(port), DW_ADMIN_PORT: String(adminPort), DW_API_KEY: KEY }, storeFactory: makeStore, signals, io: { log: (...args) => { output.push(args); if (String(args[0]).startsWith("账号池管理台:")) notify(); }, warn: (...args) => output.push(args) } });
  try {
    await Promise.race([ready, serving]);
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${adminPort}/health`)).status, 200);
    assert(!JSON.stringify(output).includes(KEY));
  } finally { signals.emit("SIGTERM"); await serving; }
  assert.equal(signals.listenerCount("SIGTERM"), 0);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
  await assert.rejects(fetch(`http://127.0.0.1:${adminPort}/health`));
});
