// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { createStore } from "../gateway/store.mjs";
import { createAdmin } from "../gateway/admin.mjs";
import { createGateway } from "../gateway/server.mjs";
import { saveAuth, fail } from "../protocol.mjs";

const key = "account-health-test-key";
const model = { id: "flash", name: "Flash", agentMode: 2, modeId: "3", deepThink: 0, extra: {} };
const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const reply = (text = "hi") => new Response(frame("CHUNK_DELTA", { text }) + frame("SSE_REPLY_END", {}));
const auth = (id, cookie = `PRIVATE_HEALTH_COOKIE_${id}`) => saveAuth({ userId: id, enterpriseType: "0", name: `账号-${id}`, cookieHeader: `sessionid=${cookie}` });
const makeStore = (root) => createStore(root, { secureRoot: (path) => mkdir(path, { recursive: true, mode: 0o700 }) });
const health = (state, startedAt, source = "probe") => ({ state, source, startedAt, checkedAt: startedAt, ...(state !== "ok" ? { message: "账号请求未成功" } : {}) });

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "dw-account-health-"));
  assert.equal(dirname(resolve(root)), resolve(tmpdir()));
  assert(basename(root).startsWith("dw-account-health-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = makeStore(root);
  await store.save(auth("a"));
  await store.save(auth("b"));
  const posts = [];
  const api = {
    catalog: async () => ({ bot: "BOT", models: { flash: model } }),
    identify: async (secret) => secret,
    usage: async () => ({ windows: [{ name: "5 小时", used: 12 }] }),
    post: async (...args) => { posts.push(args); return reply(); },
    ...options.api,
  };
  async function startAdmin() {
    const admin = createAdmin({ store, api, apiKey: key, health: () => true, config: { hideHistory: false, ...options.config } });
    t.after(() => admin.close());
    admin.server.listen(0, "127.0.0.1");
    await once(admin.server, "listening");
    const url = `http://127.0.0.1:${admin.server.address().port}`;
    const { token } = await (await fetch(url + "/api/session")).json();
    const call = (path, { method = "GET", body, ...rest } = {}) => fetch(url + path, { ...rest, method,
      headers: { "X-Doubao-Admin": token, ...(method !== "GET" ? { Origin: url, "Content-Type": "application/json" } : {}) },
      ...(method !== "GET" ? { body: JSON.stringify(body || {}) } : {}),
    });
    return { admin, call, url };
  }
  const admin = await startAdmin();
  async function startGateway(overrides = {}) {
    const gateway = createGateway({ store, apiKey: key, api, heartbeatMs: 0, hideHistory: false, ...overrides });
    t.after(() => gateway.close());
    gateway.server.listen(0, "127.0.0.1");
    await once(gateway.server, "listening");
    const url = `http://127.0.0.1:${gateway.server.address().port}`;
    const call = (path, init = {}) => fetch(url + path, { ...init, headers: { Authorization: `Bearer ${key}`, ...init.headers } });
    const post = (path, body, init = {}) => call(path, { ...init, method: "POST", headers: { "Content-Type": "application/json", ...init.headers }, body: JSON.stringify(body) });
    return { gateway, call, post };
  }
  return { root, store, api, posts, ...admin, startAdmin, startGateway };
}

test("探活：发送完整最小对话，记录结果并保留凭据、名称和手动停用状态", async (t) => {
  const f = await fixture(t);
  await f.store.update("a:0", { name: "手动停用账号", enabled: false });
  const before = await f.store.account("a:0", { allowDisabled: true });
  const response = await f.call("/api/accounts/a%3A0/probe", { method: "POST" });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.state, "ok");
  assert.equal(result.source, "probe");
  assert(result.checkedAt > 0);
  assert.equal(f.posts.length, 1);
  assert.equal(f.posts[0][1], "/chat/completion");
  assert.equal(f.posts[0][3].stream, true);
  assert.match(f.posts[0][2].messages[0].content_block[0].content.text_block.text, /hi/);
  const after = await makeStore(f.root).account("a:0", { allowDisabled: true });
  assert.deepEqual(after.auth, before.auth);
  assert.equal(after.name, "手动停用账号");
  assert.equal(after.enabled, false);
  assert.equal(after.health.state, "ok");
  assert.equal((await f.store.account()).uid, "b:0");
  assert(!JSON.stringify(result).includes("PRIVATE_"));
});

test("探活：HTTP 200 内的上游业务错误归入失效，默认账号切换且重启后保留", async (t) => {
  const f = await fixture(t, { api: { post: async () => new Response(frame("SSE_ERR", { code: 710012001, msg: "login required PRIVATE_PAYLOAD" })) } });
  const before = (await f.store.account("a:0")).auth;
  const result = await (await f.call("/api/accounts/a%3A0/probe", { method: "POST" })).json();
  assert.equal(result.state, "expired");
  const invalid = (await makeStore(f.root).list()).find((account) => account.uid === "a:0");
  assert.equal(invalid.invalid, true);
  assert.equal(invalid.enabled, true);
  assert.match(invalid.health.message, /登录已失效/);
  assert(!invalid.default);
  await assert.rejects(f.store.account("a:0"), /已失效/);
  assert.deepEqual((await f.store.account("a:0", { allowDisabled: true })).auth, before);
  assert.equal((await f.store.account()).uid, "b:0");
  assert.equal((await f.call("/api/accounts/a%3A0/default", { method: "POST" })).status, 409);
  await f.admin.close();
  const restarted = await f.startAdmin();
  const overview = await (await restarted.call("/api/overview")).json();
  assert.equal(overview.accounts[0].invalid, true);
  assert.equal(overview.accounts[0].check.state, "expired");
  assert(!JSON.stringify(overview).includes("PRIVATE_"));
});

test("恢复：仅查询会话不能恢复失效账号，完整探活成功后恢复", async (t) => {
  let failing = true;
  const f = await fixture(t, { api: { post: async () => { if (failing) throw fail(502, "上游暂时拒绝请求"); return reply(); } } });
  await f.call("/api/accounts/a%3A0/probe", { method: "POST" });
  assert.equal((await (await f.call("/api/accounts/a%3A0/check", { method: "POST" })).json()).state, "ok");
  assert.equal((await (await f.call("/api/overview")).json()).accounts[0].invalid, true);
  failing = false;
  assert.equal((await (await f.call("/api/accounts/a%3A0/probe", { method: "POST" })).json()).state, "ok");
  assert.equal((await f.store.list())[0].invalid, false);
  assert.equal((await f.store.account("a:0")).uid, "a:0");
});

test("会话检测：额度查询错误也归入失效，未知异常不泄露凭据", async (t) => {
  const f = await fixture(t, { api: { usage: async () => { throw Error("PRIVATE_COOKIE_IN_EXCEPTION"); } } });
  const result = await (await f.call("/api/accounts/a%3A0/check", { method: "POST" })).json();
  assert.equal(result.state, "error");
  assert.equal((await f.store.list())[0].invalid, true);
  assert(!JSON.stringify(result).includes("PRIVATE_"));
  const stored = JSON.parse(await readFile(join(f.root, "accounts.json"), "utf8"));
  assert(!JSON.stringify(stored.accounts[0].health).includes("PRIVATE_"));
});

test("恢复：探活成功后清除旧会话与额度错误文案，不展示已失效的检测缓存", async (t) => {
  const f = await fixture(t, { api: { usage: async () => { throw Object.assign(fail(401, "旧会话已失效"), { reason: "session_expired" }); } } });
  await f.call("/api/accounts/a%3A0/check", { method: "POST" });
  const failed = (await (await f.call("/api/overview")).json()).accounts[0];
  assert.equal(failed.invalid, true);
  assert.match(failed.check.usageError, /旧会话/);
  await f.call("/api/accounts/a%3A0/probe", { method: "POST" });
  const recovered = (await (await f.call("/api/overview")).json()).accounts[0];
  assert.equal(recovered.invalid, false);
  assert.equal(recovered.check.state, "ok");
  assert.equal(recovered.check.message, undefined);
  assert.equal(recovered.check.usageError, undefined);
});

test("探活：中途错误、空回答和目录错误均不会误报成功", async (t) => {
  const cases = [
    { name: "部分回答后错误", api: { post: async () => new Response(frame("CHUNK_DELTA", { text: "partial" }) + frame("SSE_ERR", { code: 710022004 })) } },
    { name: "没有回答正文", api: { post: async () => new Response(frame("SSE_REPLY_END", {})) } },
    { name: "目录为空", api: { catalog: async () => ({ bot: "BOT", models: {} }) } },
    { name: "未知上游异常", api: { catalog: async () => { throw Error("PRIVATE_CATALOG_COOKIE"); } } },
  ];
  for (const item of cases) await t.test(item.name, async (t) => {
    const f = await fixture(t, item);
    const result = await (await f.call("/api/accounts/a%3A0/probe", { method: "POST" })).json();
    assert.notEqual(result.state, "ok");
    assert.equal((await f.store.list())[0].invalid, true);
    assert(!JSON.stringify(result).includes("PRIVATE_"));
  });
});

test("探活：同会话重复请求共用一次上游对话，接口方法和来源仍受保护", async (t) => {
  let posts = 0;
  const f = await fixture(t, { api: { post: async () => { posts++; await delay(50); return reply(); } } });
  const results = await Promise.all([f.call("/api/accounts/a%3A0/probe", { method: "POST" }), f.call("/api/accounts/a%3A0/probe", { method: "POST" })]);
  assert(results.every((response) => response.status === 200));
  assert.equal(posts, 1);
  assert.equal((await f.call("/api/accounts/a%3A0/probe")).status, 405);
  assert.equal((await f.call("/api/accounts/missing/probe", { method: "POST" })).status, 404);
  assert.equal((await fetch(f.url + "/api/accounts/a%3A0/probe", { method: "POST", headers: { Origin: "https://example.test", "Content-Type": "application/json" }, body: "{}" })).status, 403);
});

test("探活：超时和调用方取消会中断上游，不把取消误记为失效", async (t) => {
  const api = { post: async (_secret, _path, _payload, { signal }) => { await delay(10000, undefined, { signal }); return reply(); } };
  const timed = await fixture(t, { config: { timeoutMs: 40 }, api });
  assert.equal((await timed.call("/api/accounts/a%3A0/probe", { method: "POST" })).status, 504);
  assert.equal((await timed.store.list())[0].invalid, false);
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const cancelled = await fixture(t, { api: { post: async (...args) => { entered(); return api.post(...args); } } });
  const controller = new AbortController();
  const request = cancelled.call("/api/accounts/a%3A0/probe", { method: "POST", signal: controller.signal });
  await started;
  controller.abort();
  await assert.rejects(request);
  await delay(20);
  assert.equal((await cancelled.store.list())[0].invalid, false);
});

test("存储：并发探活保存所有失效账号，无可用账号时明确拒绝服务", async (t) => {
  const f = await fixture(t, { api: { post: async () => { await delay(20); throw fail(502, "上游返回错误"); } } });
  const responses = await Promise.all([f.call("/api/accounts/a%3A0/probe", { method: "POST" }), f.call("/api/accounts/b%3A0/probe", { method: "POST" })]);
  assert(responses.every((response) => response.status === 200));
  assert((await makeStore(f.root).list()).every((account) => account.invalid && !account.default));
  await assert.rejects(f.store.account(), /没有可用账号/);
  f.api.post = async () => reply();
  await f.call("/api/accounts/b%3A0/probe", { method: "POST" });
  assert.equal((await f.store.account()).uid, "b:0");
});

test("存储：迟到结果不会覆盖新登录、新探活或复活已移除账号", async (t) => {
  const f = await fixture(t);
  const old = await f.store.account("a:0");
  await f.store.recordHealth(old, health("error", 10));
  await f.store.recordHealth(old, health("ok", 30));
  assert.equal(await f.store.recordHealth(old, health("error", 20)), false);
  assert.equal((await f.store.list())[0].invalid, false);
  await f.store.save(auth("a", "NEW_PRIVATE_COOKIE"));
  assert.equal(await f.store.recordHealth(old, health("error", 40)), false);
  assert.equal((await f.store.account("a:0")).secret.cookieHeader, "sessionid=NEW_PRIVATE_COOKIE");
  const current = await f.store.account("a:0");
  await f.store.remove("a:0");
  assert.equal(await f.store.recordHealth(current, health("error", 50)), false);
  assert.equal((await f.store.list()).length, 1);
});

test("普通调用：三种协议的上游错误均自动归入失效，后续请求使用其他账号", async (t) => {
  const cases = [
    ["chat", "/v1/chat/completions", { model: "flash", messages: [{ role: "user", content: "hello" }] }],
    ["responses", "/v1/responses", { model: "flash", input: "hello" }],
    ["messages", "/v1/messages", { model: "flash", max_tokens: 32, messages: [{ role: "user", content: "hello" }] }],
  ];
  for (const [name, path, body] of cases) for (const stream of [false, true]) await t.test(`${name} ${stream ? "stream" : "JSON"}`, async (t) => {
    const f = await fixture(t, { api: { post: async (secret) => secret.userId === "a"
      ? new Response(frame("CHUNK_DELTA", { text: "partial" }) + frame("SSE_ERR", { code: 710022004 })) : reply("healthy account") } });
    const g = await f.startGateway();
    const response = await g.post(path, { ...body, stream });
    let text = "";
    try { text = await response.text(); } catch (error) { assert.equal(name, "chat"); assert(stream); }
    assert(!text.includes("[DONE]") && !text.includes("response.completed") && !text.includes("message_stop"));
    for (let i = 0; i < 100 && !(await f.store.list())[0].invalid; i++) await delay(5);
    assert.equal((await f.store.list())[0].invalid, true);
    assert.equal((await f.store.account()).uid, "b:0");
    assert.equal((await (await f.call("/api/overview")).json()).accounts[0].check.state, "limited");
    assert.equal((await g.post(path, body)).status, 200);
  });
});

test("普通调用：模型和额度上游错误归入失效，固定失效账号不会被继续调用", async (t) => {
  for (const path of ["/v1/models", "/v1/usage"]) await t.test(path, async (t) => {
    const reject = async () => { throw Object.assign(fail(401, "会话失效"), { reason: "session_expired" }); };
    const f = await fixture(t, { api: { catalog: reject, usage: reject } });
    const g = await f.startGateway({ accountId: "a:0" });
    assert.equal((await g.call(path)).status, 401);
    assert.equal((await f.store.list())[0].invalid, true);
    assert.equal((await g.call(path)).status, 503);
  });
});

test("普通调用：上游明确返回 HTTP 504 错误时仍归入失效，网关等待超时保持账号状态", async (t) => {
  const returned = await fixture(t, { api: { post: async () => { throw Object.assign(fail(504, "上游服务返回超时错误"), { reason: "upstream_error" }); } } });
  const g = await returned.startGateway();
  const body = { model: "flash", messages: [{ role: "user", content: "hello" }] };
  assert.equal((await g.post("/v1/chat/completions", body)).status, 504);
  assert.equal((await returned.store.list())[0].invalid, true);
  const timed = await fixture(t, { api: { post: async (_secret, _path, _payload, { signal }) => { await delay(10000, undefined, { signal }); return reply(); } } });
  const waiting = await timed.startGateway({ timeoutMs: 40 });
  assert.equal((await waiting.post("/v1/chat/completions", body)).status, 504);
  assert.equal((await timed.store.list())[0].invalid, false);
});

test("普通调用：客户端鉴权、参数、模型错误和本地并发限制不使账号失效", async (t) => {
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const f = await fixture(t, { api: { post: async (_secret, _path, _payload, { signal }) => { entered(); await delay(10000, undefined, { signal }); return reply(); } } });
  const g = await f.startGateway({ maxConcurrency: 1 });
  const body = { model: "flash", messages: [{ role: "user", content: "hello" }] };
  assert.equal((await g.call("/v1/models", { headers: { Authorization: "Bearer invalid" } })).status, 401);
  assert.equal((await g.call("/v1/models/missing")).status, 404);
  assert.equal((await g.post("/v1/chat/completions", { ...body, response_format: { type: "json_object" } })).status, 400);
  assert((await f.store.list()).every((account) => !account.invalid));
  const controller = new AbortController();
  const pending = g.post("/v1/chat/completions", body, { signal: controller.signal });
  await started;
  assert.equal((await g.post("/v1/chat/completions", body)).status, 429);
  controller.abort();
  await assert.rejects(pending);
  await delay(20);
  assert((await f.store.list()).every((account) => !account.invalid));
});
