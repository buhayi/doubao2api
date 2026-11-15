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

test("管理台：展示人工验证状态与等待配置，完成后状态更新", async (t) => {
  let state = "manual";
  const f = await fixture(t, { verificationStatus: () => ({ accounts: { "a:0": { state, expiresAt: 12345 } } }) });
  assert.equal((await (await f.call("/api/overview")).json()).gateway.verification.accounts["a:0"].state, "manual");
  const settings = await (await f.call("/api/settings")).json();
  assert.equal(settings.captcha.manualFallback, true);
  assert.equal(settings.captcha.manualTimeoutMs, 300000);
  assert.equal(settings.captcha.mode, "manual");
  assert.equal(settings.captcha.automatic, false);
  state = "verified";
  assert.equal((await (await f.call("/api/overview")).json()).gateway.verification.accounts["a:0"].state, "verified");
});

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

test("管理台：移除签到后旧接口不可用，概览不含签到状态且不请求上游领取", async (t) => {
  const posts = [];
  const f = await fixture(t, { api: { post: async (...args) => { posts.push(args); throw Error("Unexpected upstream claim"); } } });
  const before = await readFile(join(f.root, "accounts.json"), "utf8");
  for (const path of ["/api/checkin", "/api/accounts/a%3A0/checkin"])
    for (const method of ["GET", "POST"]) assert.equal((await f.call(path, { method })).status, 404);
  const overview = await (await f.call("/api/overview")).json();
  assert.equal(Object.hasOwn(overview, "checkin"), false);
  assert(overview.accounts.every(account => !Object.hasOwn(account, "checkin")));
  assert.equal((await f.call("/api/accounts/a%3A0/check", { method: "POST" })).status, 200);
  assert.deepEqual(posts, []);
  assert.equal(await readFile(join(f.root, "accounts.json"), "utf8"), before);
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
