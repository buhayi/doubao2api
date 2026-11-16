// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename, resolve } from "node:path";
import { activateWorkClient, createClientVerificationManager } from "../desktop/verification.mjs";
import { importClientAccounts } from "../desktop/sessions.mjs";
import { createGateway } from "../gateway/server.mjs";
import { createAdmin } from "../gateway/admin.mjs";
import { createStore } from "../gateway/store.mjs";
import { runCli } from "../gateway/cli.mjs";
import { vendorError, saveAuth } from "../protocol.mjs";

const key = "CLIENT_VERIFICATION_TEST_KEY";
const secret = { userId: "a", enterpriseType: "0", name: "测试账号", cookieHeader: "sessionid=PRIVATE_CLIENT_VERIFICATION_COOKIE" };
const account = { uid: "a:0", name: "测试账号", secret };
const model = { id: "flash", name: "Flash", agentMode: 2, modeId: "3", deepThink: 4, extra: {} };
const decision = { code: 710022004, extra: { decision: { type: "verify", challenge: "PRIVATE_CLIENT_CHALLENGE" } } };
const rejection = () => vendorError(429, decision);
const frame = (event, value) => `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
const ack = frame("SSE_ACK", { ack_client_meta: { conversation_id: "fixture-created" } });
const verificationFrame = frame("SSE_ERROR", decision);
const answer = () => new Response(ack + frame("CHUNK_DELTA", { text: "ok" }) + frame("SSE_REPLY_END", {}));
const protocols = [
  ["chat", "/v1/chat/completions", { model: "flash", messages: [{ role: "user", content: "fixture" }] }],
  ["responses", "/v1/responses", { model: "flash", input: "fixture" }],
  ["claude", "/v1/messages", { model: "flash", max_tokens: 128, messages: [{ role: "user", content: "fixture" }] }],
];

function manual(t, options = {}) {
  const launches = [], notices = [];
  const manager = createClientVerificationManager({ platform: "win32", activate: async (options) => { launches.push(options); return { state: "foreground", launched: false }; },
    notify: (text) => notices.push(text), ...options });
  t.after(() => manager.dispose());
  return { manager, launches, notices };
}
function taskResult(stdout, capture) {
  const task = Promise.resolve({ stdout });
  task.child = { stdin: { on() {}, end(text) { capture.input = JSON.parse(text); } } };
  return task;
}
async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), "dw-client-verification-"));
  assert.equal(dirname(resolve(root)), resolve(tmpdir()));
  assert(basename(root).startsWith("dw-client-verification-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function gateway(t, options = {}) {
  const activation = manual(t, options.manager);
  const posts = [], health = [];
  const api = { catalog: async () => ({ bot: "BOT", models: { flash: model } }), usage: async () => ({}),
    post: async (...args) => { posts.push(args); return args[1] === "/chat/completion" ? answer() : { status_code: 0 }; }, ...options.api };
  const service = createGateway({ heartbeatMs: 0, deleteHistory: false, edition: "work-client", clientVerification: activation.manager, ...options,
    store: { account: async () => account, recordHealth: async (_account, value) => health.push(value), ...options.store }, api, apiKey: key });
  service.server.listen(0, "127.0.0.1");
  await once(service.server, "listening");
  t.after(() => service.close());
  const url = `http://127.0.0.1:${service.server.address().port}`;
  const call = (path, init = {}) => fetch(url + path, { ...init, headers: { Authorization: `Bearer ${key}`, ...init.headers } });
  const post = (path, body) => call(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { ...activation, service, api, posts, health, url, call, post };
}

test("客户端唤起：正常客户端路径通过 stdin 传入隐藏辅助程序", async () => {
  const capture = {};
  const result = await activateWorkClient({ platform: "win32", env: { SystemRoot: "C:\\Windows", DW_DOUBAO_WORK_PROFILE: "C:\\Client Work\\User Data" },
    discover: async () => [{ id: "doubaowork", path: "E:\\Doubao Work\\app\\DoubaoWork.exe" }],
    execute: (file, args, options) => { Object.assign(capture, { file, args, options }); return taskResult('{"state":"foreground","launched":false}', capture); },
  });
  assert.deepEqual(result, { state: "foreground", launched: false });
  assert.deepEqual(capture.input, { executable: "E:\\Doubao Work\\app\\DoubaoWork.exe", userDataDir: "C:\\Client Work\\User Data" });
  assert.match(capture.file, /WindowsPowerShell\\v1\.0\\powershell\.exe$/);
  assert.equal(capture.options.shell, false);
  assert.equal(capture.options.windowsHide, true);
  assert(capture.options.timeout <= 15000);
  assert(!capture.args.includes("--saman-browser-entry"));
  assert(!JSON.stringify(capture.args).includes("E:\\\\Doubao Work"));
});

test("客户端唤起：平台、代理程序、无效目录和辅助程序失败均安全拒绝", async () => {
  let executions = 0;
  const execute = () => { executions++; throw Error("PRIVATE_SPAWN_ERROR"); };
  const discover = async () => [{ id: "doubaowork", path: "C:\\Client\\app\\DoubaoWork.exe" }];
  await assert.rejects(activateWorkClient({ platform: "linux", discover, execute }), (e) => e.status === 400);
  await assert.rejects(activateWorkClient({ platform: "win32", discover: async () => [{ id: "doubaowork", path: "C:\\Client\\DoubaoWork_browser_proxy.exe" }], execute }), (e) => e.status === 404);
  await assert.rejects(activateWorkClient({ platform: "win32", discover, env: { DW_DOUBAO_WORK_PROFILE: "C:\\bad\npath" }, execute }), (e) => e.status === 400);
  await assert.rejects(activateWorkClient({ platform: "win32", discover, env: { DW_DOUBAO_WORK_PROFILE: "C:\\" }, execute }), (e) => e.status === 400);
  assert.equal(executions, 0);
  await assert.rejects(activateWorkClient({ platform: "win32", discover, env: {}, execute }), (e) => e.status === 503 && !e.message.includes("PRIVATE"));
  await assert.rejects(activateWorkClient({ platform: "win32", discover, env: {}, execute: () => taskResult('{"state":"PRIVATE_RESULT","launched":true}', {}) }), (e) => e.status === 503 && !e.message.includes("PRIVATE"));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(activateWorkClient({ platform: "win32", discover, execute, signal: controller.signal }), (e) => e === controller.signal.reason);
});

test("人工验证：仅明确验证触发，限流、会话过期和停用不唤起", async (t) => {
  const f = manual(t);
  for (const error of [vendorError(429), vendorError(429, { code: 710022004 }), vendorError(401), vendorError(500)]) await f.manager.handle(account, error);
  assert.equal(f.launches.length, 0);
  for (const options of [{ platform: "linux" }, { enabled: false }]) {
    const disabled = manual(t, options);
    await disabled.manager.handle(account, rejection());
    assert.equal(disabled.launches.length, 0);
    assert.equal(disabled.manager.status().enabled, false);
  }
  const error = rejection();
  await f.manager.handle(account, error);
  assert.equal(f.launches.length, 1);
  assert.equal(error.reason, "verification_required");
  assert.equal(error.status, 429);
  assert.match(error.message, /已弹到前台.*探活/);
  assert(!JSON.stringify(f.manager.status()).includes("PRIVATE"));
  assert(!JSON.stringify(f.notices).includes("PRIVATE"));
});

test("人工验证：连续验证拒绝都会重新置前，不因上一次唤起而跳过", async (t) => {
  const f = manual(t, { now: () => 1000 });
  await f.manager.handle(account, rejection());
  assert.equal(f.launches.length, 1);
  const error = rejection();
  await f.manager.handle(account, error);
  assert.equal(f.launches.length, 2);
  assert.match(error.message, /已弹到前台/);
  await f.manager.handle(account, error);
  assert.equal(f.launches.length, 2);
});

test("人工验证：并发跨账号共用唤起，显式冷却和成功探活仍受支持", async (t) => {
  let finish, count = 0, time = 1000;
  const f = manual(t, { cooldownMs: 60000, now: () => time, activate: () => { count++; return new Promise((resolve) => { finish = resolve; }); } });
  const first = f.manager.handle(account, rejection());
  const second = f.manager.handle({ ...account, uid: "b:0" }, rejection());
  await Promise.resolve();
  assert.equal(count, 1);
  assert.equal(f.manager.status().accounts["a:0"].state, "opening");
  finish({ state: "foreground" });
  await Promise.all([first, second]);
  assert.equal(f.notices.length, 1);
  assert.deepEqual(Object.keys(f.manager.status().accounts), ["a:0", "b:0"]);
  time += 59999;
  await f.manager.handle(account, rejection());
  assert.equal(count, 1);
  f.manager.verified("a:0");
  assert.equal(f.manager.status().accounts["a:0"], undefined);
  time++;
  const third = f.manager.handle(account, rejection());
  await Promise.resolve();
  assert.equal(count, 2);
  finish({ state: "foreground" });
  await third;
});

test("人工验证：置前被拒绝或唤起失败时保留验证错误并提示人工操作", async (t) => {
  for (const state of ["attention", "error"]) await t.test(state, async (t) => {
    const f = manual(t, { activate: async () => { if (state === "error") throw Error("PRIVATE_FAILURE"); return { state }; } });
    const error = rejection();
    await f.manager.handle(account, error);
    assert.equal(error.status, 429);
    assert.equal(error.reason, "verification_required");
    assert.equal(f.manager.status().accounts[account.uid].state, state);
    assert.match(error.message, state === "error" ? /手动打开/ : /任务栏/);
    assert(!error.message.includes("PRIVATE"));
  });
});

test("人工验证：取消和服务关闭阻止新唤起，关闭只中止自身辅助程序", async (t) => {
  const controller = new AbortController(); controller.abort();
  const f = manual(t);
  await f.manager.handle(account, rejection(), { signal: controller.signal });
  assert.equal(f.launches.length, 0);
  let activeSignal;
  const running = manual(t, { activate: ({ signal }) => { activeSignal = signal; return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); } });
  const error = rejection(), original = error.message;
  const pending = running.manager.handle(account, error);
  await Promise.resolve();
  await running.manager.dispose();
  await pending;
  assert(activeSignal.aborted);
  assert.equal(error.message, original);
  assert.deepEqual(running.manager.status().accounts, {});
  assert.equal(running.notices.length, 0);
  await running.manager.handle(account, rejection());
  assert.equal(running.manager.status().enabled, false);
});

test("人工验证：调用方断开后提醒状态仍结束打开过程，不留下永久正在唤起", async (t) => {
  let finish;
  const f = manual(t, { activate: () => new Promise(resolve => { finish = resolve; }) });
  const controller = new AbortController(), error = rejection(), original = error.message;
  const pending = f.manager.handle(account, error, { signal: controller.signal });
  await Promise.resolve();
  controller.abort();
  finish({ state: "foreground" });
  await pending;
  assert.equal(f.manager.status().accounts[account.uid].state, "waiting");
  assert.equal(error.message, original);
});

test("人工验证：迟到的窗口结果不会复活已由探活或重新登录清除的提醒", async (t) => {
  let finish;
  const f = manual(t, { activate: () => new Promise(resolve => { finish = resolve; }) });
  const pending = f.manager.handle(account, rejection());
  await Promise.resolve();
  f.manager.verified(account.uid);
  finish({ state: "foreground" });
  await pending;
  assert.deepEqual(f.manager.status().accounts, {});
});

test("客户端网关：三种协议的 HTTP/SSE 和流式/非流式验证仅唤起一次且不重发", async (t) => {
  for (const [name, path, body] of protocols) for (const transport of ["http", "sse"]) for (const stream of [false, true]) await t.test(`${name} ${transport} stream=${stream}`, async (t) => {
    let posts = 0;
    const f = await gateway(t, { store: { recordHealth: undefined }, api: { post: async () => { posts++; if (transport === "http") throw rejection(); return new Response(verificationFrame); } } });
    const response = await f.post(path, { ...body, stream });
    assert.equal(response.status, 429);
    const error = await response.json();
    if (name === "claude") { assert.equal(error.type, "error"); assert.equal(error.error.type, "rate_limit_error"); }
    else assert.equal(error.error.code, "verification_required");
    assert.match(JSON.stringify(error), /探活/);
    assert(!JSON.stringify(error).includes("PRIVATE"));
    assert.equal(posts, 1);
    assert.equal(f.launches.length, 1);
  });
});

test("通用网关：即使传入客户端管理器也不会唤起", async (t) => {
  const f = await gateway(t, { edition: "gateway", api: { post: async () => { throw rejection(); } } });
  const response = await f.post(protocols[0][1], protocols[0][2]);
  assert.equal(response.status, 429);
  assert.equal(f.launches.length, 0);
});

test("客户端网关：已输出部分文本的 SSE 验证仍唤起、记录失效并删除本次会话", async (t) => {
  for (const [name, path, body] of protocols) await t.test(name, async (t) => {
    let source, posts = 0, deleted = 0;
    const f = await gateway(t, { deleteHistory: true, api: { post: async (_secret, path, payload) => {
      if (path !== "/chat/completion") { deleted++; assert.deepEqual(payload.uplink_body.batch_delete_user_conversation_uplink_body.conversation_id, ["fixture-created"]); return { status_code: 0 }; }
      posts++;
      assert.equal(payload.messages[0].message_status, 1);
      assert.equal(payload.option.message_storage_type, 0);
      return new Response(new ReadableStream({ start(c) { source = c; c.enqueue(new TextEncoder().encode(ack + frame("CHUNK_DELTA", { text: "partial" }))); } }));
    } } });
    const response = await f.post(path, { ...body, stream: true });
    const reader = response.body.getReader();
    let text = "";
    while (!text.includes("partial")) text += new TextDecoder().decode((await reader.read()).value);
    source.enqueue(new TextEncoder().encode(verificationFrame)); source.close();
    try { for (;;) { const part = await reader.read(); if (part.done) break; text += new TextDecoder().decode(part.value); } } catch (error) { assert.equal(name, "chat"); }
    await f.service.close();
    assert.equal(f.launches.length, 1);
    assert.equal(posts, 1);
    assert.equal(deleted, 1);
    assert.equal(f.health[0].state, "verification");
    assert.match(f.manager.status().accounts[account.uid].message, /探活/);
    assert(!text.includes("PRIVATE"));
    assert(!text.includes("[DONE]"));
  });
});

test("客户端网关：模型、额度、token 查询的验证都会提示", async (t) => {
  for (const path of ["/v1/models", "/v1/usage", "/v1/messages/count_tokens"]) await t.test(path, async (t) => {
    const f = await gateway(t, { api: { catalog: async () => { throw rejection(); }, usage: async () => { throw rejection(); } } });
    const response = path.endsWith("count_tokens") ? await f.post(path, protocols[2][2]) : await f.call(path);
    assert.equal(response.status, 429);
    await response.json();
    assert.equal(f.launches.length, 1);
  });
});

test("客户端管理台：显示待验证账号，探活成功恢复账号并清除提醒", async (t) => {
  const root = await directory(t), f = manual(t);
  const store = createStore(root, { secureRoot: (path) => mkdir(path, { recursive: true }) });
  await store.save(saveAuth(secret));
  let blocked = true, posts = 0;
  const api = { identify: async () => secret, usage: async () => { if (blocked) throw rejection(); return {}; },
    catalog: async () => { if (blocked) throw rejection(); return { bot: "BOT", models: { flash: model } }; },
    post: async () => { posts++; return answer(); } };
  const admin = createAdmin({ store, api, config: { edition: "work-client", deleteHistory: false }, health: () => true, clientVerification: f.manager });
  t.after(() => admin.close());
  admin.server.listen(0, "127.0.0.1"); await once(admin.server, "listening");
  const url = `http://127.0.0.1:${admin.server.address().port}`;
  const { token } = await (await fetch(url + "/api/session")).json();
  const call = (path, method = "GET") => fetch(url + path, { method, headers: { "X-Doubao-Admin": token, ...(method === "POST" ? { Origin: url, "Content-Type": "application/json" } : {}) }, ...(method === "POST" ? { body: "{}" } : {}) });
  assert.equal((await (await call("/api/accounts/a%3A0/check", "POST")).json()).state, "verification");
  assert.equal((await call("/api/accounts/a%3A0/models")).status, 429);
  assert.equal((await (await call("/api/accounts/a%3A0/probe", "POST")).json()).state, "verification");
  const settings = await (await call("/api/settings")).json();
  assert.equal(settings.clientVerification.enabled, true);
  assert.equal(settings.clientVerification.automatic, false);
  assert.equal(settings.captcha.enabled, false);
  const overview = await (await call("/api/overview")).json();
  assert.equal(overview.accounts[0].invalid, true);
  assert.equal(overview.gateway.clientVerification.accounts["a:0"].state, "waiting");
  assert(!JSON.stringify(overview).includes("PRIVATE"));
  assert.equal(f.launches.length, 3);
  assert.equal(posts, 0);
  blocked = false;
  assert.equal((await (await call("/api/accounts/a%3A0/probe", "POST")).json()).state, "ok");
  assert.equal(posts, 1);
  assert.equal((await store.account()).uid, "a:0");
  assert.deepEqual((await (await call("/api/overview")).json()).gateway.clientVerification.accounts, {});
});

test("客户端 CLI：模型错误唤起后保留原错误，普通版不创建管理器", async (t) => {
  const cwd = await directory(t), f = manual(t), calls = [];
  for (const clientMode of [false, true]) {
    const error = rejection();
    await assert.rejects(runCli({ argv: ["models"], cwd, env: {}, clientMode, io: { log() {}, table() {} }, signals: new EventEmitter(),
      storeFactory: () => ({ account: async () => account }), api: { catalog: async () => { throw error; } },
      clientVerificationFactory: () => { calls.push(clientMode); return f.manager; },
    }), (value) => value === error);
  }
  assert.deepEqual(calls, [true]);
  assert.equal(f.launches.length, 1);
});

test("客户端导入：验证拒绝唤起，普通限流不唤起，公开结果不含私密数据", async (t) => {
  const f = manual(t);
  const result = await importClientAccounts({ store: { list: async () => [], save: async () => ({ uid: "a:0" }) },
    loadSessions: async () => [{ profile: "Default", secret }, { profile: "Profile 3", secret: { ...secret, verify: true } }, { profile: "Profile 4", secret: { ...secret, limited: true } }],
    api: { identify: async (value) => { if (value.verify) throw rejection(); if (value.limited) throw vendorError(429); return value; } }, onVerification: f.manager.handle,
  });
  assert.deepEqual(result, { imported: 1, failed: 2 });
  assert.equal(f.launches.length, 1);
  assert.equal(f.manager.status().accounts["client:Profile 3"].state, "waiting");
  assert(!JSON.stringify(result).includes("PRIVATE"));
});
