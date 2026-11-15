// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { join, dirname, resolve, basename } from "node:path";
import { createVerificationManager, withAutomaticVerification } from "../verification.mjs";
import { createStore } from "../gateway/store.mjs";
import { createCompletion } from "../completion.mjs";
import { credentials, vendorError, verificationDecision, saveAuth } from "../protocol.mjs";

const secret = (userId = "a", session = "OLD") => credentials({ cookieHeader: `sessionid=${session}; s_v_web_id=OLD_FP`, userId, enterpriseType: "0", deviceId: "REAL_DEVICE", webId: "REAL_WEB" });
const decision = { type: "verify", subtype: "slide", challenge: "PRIVATE_CHALLENGE" };
const rejection = () => vendorError(429, { code: 710022004, extra: { decision } });
const deferred = () => Promise.withResolvers();
const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const verificationFrame = frame("SSE_ERROR", { code: 710022004, extra: { decision } });
const model = { id: "flash", name: "Flash", agentMode: 2, modeId: "3", deepThink: 4, extra: {} };
const body = { model: "flash", messages: [{ role: "user", content: "fixture" }], stream: true };
const catalog = async () => ({ bot: "BOT", models: { flash: model } });
const success = () => new Response(frame("CHUNK_DELTA", { text: "OK" }) + frame("SSE_REPLY_END", {}));

async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), "dw-verification-test-"));
  assert.equal(dirname(root), resolve(tmpdir()));
  assert(basename(root).startsWith("dw-verification-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function fixture(t, options = {}) {
  const root = await directory(t), runs = [], saved = [], waiting = [];
  const publish = () => { for (const wait of waiting) if (runs.length >= wait.count) wait.resolve(); };
  const manager = createVerificationManager({
    root, timeoutMs: 10_000, solver: { available: async () => ({ state: "installed" }) },
    discover: async () => [{ id: "edge", path: "fixture-browser" }],
    protectProfile: async () => {},
    ...options.managerOptions,
    launch: async (_choice, profile) => {
      const run = { profile, gate: deferred(), manualGate: deferred(), popups: 0, passed: false, closed: false };
      return {
        restore: async (account) => { run.secret = account; runs.push(run); publish(); },
        captcha: {
          show: async (value) => { assert.deepEqual(value, decision); return true; },
          capture: async () => { await run.gate.promise; return null; },
          passed: async () => { await run.gate.promise; return true; },
          requestManual: async () => { run.popups++; run.manualGate.resolve(); },
          ...options.captcha?.(run),
        },
        cookies: async () => [
          { name: "sessionid", value: "NEW_" + run.secret.userId, domain: ".doubao.com", path: "/", expires: -1 },
          { name: "s_v_web_id", value: "NEW_FP", domain: ".doubao.com", path: "/", expires: -1 },
        ],
        identity: async () => ({ webId: "REAL_WEB", deviceId: "REAL_DEVICE" }),
        dispose: async () => { run.closed = true; },
      };
    },
    api: { identify: async (account) => ({ ...account, userId: options.mismatch ? "other" : account.userId }) },
    store: { refreshSession: async (...args) => saved.push(args) },
  });
  t.after(async () => { for (const run of runs) run.gate.resolve(); await manager.dispose(); });
  return { root, manager, runs, saved, started(count) {
    if (runs.length >= count) return Promise.resolve();
    const gate = deferred(); waiting.push({ count, resolve: gate.resolve }); return gate.promise;
  } };
}

test("验证 decision 只在内部保存，不出现在公开错误和日志字段中", () => {
  const error = rejection();
  assert.deepEqual(verificationDecision(error), decision);
  assert(!JSON.stringify(error).includes("PRIVATE_CHALLENGE"));
  assert(!error.message.includes("PRIVATE_CHALLENGE"));
  const rate = vendorError(429, { code: 710022004 });
  assert.equal(verificationDecision(rate), undefined);
  assert.equal(rate.reason, "rate_limited");
});

test("同一账号并发请求共用一次验证，更新指纹后核验身份再保存会话", async (t) => {
  const f = await fixture(t), account = secret();
  const a = f.manager.recover(account, rejection());
  const b = f.manager.recover(account, rejection());
  await f.started(1);
  assert.equal(f.runs.length, 1);
  f.runs[0].gate.resolve();
  const [first, second] = await Promise.all([a, b]);
  assert.equal(first, second);
  assert.equal(first.fingerprint, "NEW_FP");
  assert.equal(first.deviceId, "REAL_DEVICE");
  assert.equal(first.webId, "REAL_WEB");
  assert.equal(f.saved.length, 1);
  assert.equal(f.saved[0][0], "a:0");
  assert.equal(f.saved[0][2].expectedCookieHeader, account.cookieHeader);
  assert(f.runs[0].closed);
  assert.deepEqual(await readdir(join(f.root, "tmp")), []);
  assert(!JSON.stringify(f.manager.status()).includes("OLD_FP"));
  assert(!JSON.stringify(f.manager.status()).includes("PRIVATE_CHALLENGE"));
});

test("不同账号即使收到相同 Cookie 文本也不会共用验证窗口", async (t) => {
  const f = await fixture(t);
  const a = f.manager.recover(secret("a"), rejection());
  const b = f.manager.recover(secret("b"), rejection());
  await f.started(2);
  assert.notEqual(f.runs[0].profile, f.runs[1].profile);
  for (const run of f.runs) run.gate.resolve();
  const [first, second] = await Promise.all([a, b]);
  assert.equal(first.userId, "a");
  assert.equal(second.userId, "b");
  assert.equal(f.saved.length, 2);
});

test("一个请求取消不影响共用验证，所有等待者取消后不保存迟到结果", async (t) => {
  const f = await fixture(t), account = secret();
  const controller = new AbortController();
  const a = f.manager.recover(account, rejection(), { signal: controller.signal });
  const cancelled = assert.rejects(a, (e) => e.name === "AbortError");
  const b = f.manager.recover(account, rejection());
  await f.started(1);
  controller.abort();
  await cancelled;
  assert.equal(f.runs[0].closed, false);
  f.runs[0].gate.resolve();
  assert.equal((await b).userId, "a");
  assert.equal(f.saved.length, 1);

  const allCancelled = new AbortController();
  const c = f.manager.recover(secret("c"), rejection(), { signal: allCancelled.signal });
  const stopped = assert.rejects(c, (e) => e.name === "AbortError");
  await f.started(2);
  allCancelled.abort();
  await stopped;
  f.runs[1].gate.resolve();
  await f.manager.dispose();
  assert(f.runs[1].closed);
  assert.equal(f.saved.length, 1);
});

test("身份不一致拒绝更新账号，普通限流和失效会话不会弹出验证窗口", async (t) => {
  const f = await fixture(t, { mismatch: true }), error = rejection();
  const task = f.manager.recover(secret(), error);
  const rejected = assert.rejects(task, (e) => e === error);
  await f.started(1);
  f.runs[0].gate.resolve();
  await rejected;
  assert.equal(f.saved.length, 0);
  assert(f.runs[0].closed);
  for (const other of [vendorError(429), vendorError(401)])
    await assert.rejects(f.manager.recover(secret(), other), (e) => e === other);
  assert.equal(f.runs.length, 1);
});

const unsupportedCaptcha = (run) => ({
  capture: async () => ({ kind: "unsupported", signature: "unsupported", request: { kind: "unsupported" } }),
  passed: async () => run.passed,
});

test("遇到人机验证立即弹窗且不启动识别，并发请求共享状态和成功会话", async (t) => {
  let captures = 0, solves = 0;
  const f = await fixture(t, {
    managerOptions: { pollMs: 2, autoEnabled: true, solver: { solve: async () => { solves++; throw Error("人工模式不应启动识别"); } } },
    captcha: (run) => ({ capture: async () => { captures++; return { kind: "slide", signature: "failed", request: { kind: "slide", background: "aW1hZ2U=" } }; }, passed: async () => run.passed }),
  });
  const firstStates = [], secondStates = [];
  const a = f.manager.recover(secret(), rejection(), { onVerification: (state) => firstStates.push(state) });
  await f.started(1);
  const run = f.runs[0];
  await run.manualGate.promise;
  const b = f.manager.recover(secret(), rejection(), { onVerification: (state) => secondStates.push(state) });
  assert.equal(run.popups, 1);
  assert.equal(f.saved.length, 0);
  assert.equal(f.manager.status().accounts["a:0"].state, "manual");
  assert.equal(f.manager.status().mode, "manual");
  assert.equal(f.manager.status().automatic, false);
  assert.equal(secondStates[0].state, "manual");
  assert.equal(secondStates[0].expiresAt, firstStates.find((state) => state.state === "manual" && Number.isSafeInteger(state.expiresAt)).expiresAt);
  run.passed = true;
  const [first, second] = await Promise.all([a, b]);
  assert.equal(first, second);
  assert.equal(f.saved.length, 1);
  assert.equal(captures, 0);
  assert.equal(solves, 0);
  assert.equal(run.popups, 1);
  assert(run.closed);
  assert(firstStates.some((state) => state.state === "verified"));
});

test("人工等待使用独立期限，普通身份核验超时不会提前关闭窗口", async (t) => {
  const f = await fixture(t, { managerOptions: { timeoutMs: 40, pollMs: 2, manualTimeoutMs: 2000 },
    captcha: (run) => ({ passed: async () => run.passed }) });
  const task = f.manager.recover(secret(), rejection());
  await f.started(1);
  const run = f.runs[0];
  // A real browser socket keeps the event loop alive while the timeout fires.
  await Promise.all([run.manualGate.promise, delay(60)]);
  assert.equal(run.closed, false);
  assert.equal(f.saved.length, 0);
  run.passed = true;
  assert.equal((await task).userId, "a");
  assert.equal(f.saved.length, 1);
  run.gate.resolve();
});

test("人工等待超时关闭窗口并保留验证错误，迟到成功不更新会话", async (t) => {
  const f = await fixture(t, { managerOptions: { manualTimeoutMs: 60, pollMs: 2 }, captcha: unsupportedCaptcha });
  const error = rejection(), task = f.manager.recover(secret(), error);
  const rejected = assert.rejects(task, (cause) => cause === error);
  await f.started(1);
  await f.runs[0].manualGate.promise;
  await rejected;
  f.runs[0].passed = true;
  assert.equal(f.saved.length, 0);
  assert(f.runs[0].closed);
  assert.equal(f.manager.status().accounts["a:0"].state, "expired");
  assert.deepEqual(await readdir(join(f.root, "tmp")), []);
});

test("关闭人工验证码或取消原请求均停止恢复，不保存迟到结果", async (t) => {
  for (const close of [true, false]) await t.test(close ? "关闭官网验证码" : "取消原请求", async (t) => {
    const f = await fixture(t, { managerOptions: { pollMs: 2 }, captcha: (run) => ({
      ...unsupportedCaptcha(run), outcome: async () => ({ closed: run.userClosed, passed: run.passed }),
    }) });
    const controller = new AbortController(), error = rejection();
    const task = f.manager.recover(secret(), error, { signal: controller.signal });
    const rejected = assert.rejects(task, (cause) => close ? cause === error : cause.name === "AbortError");
    await f.started(1);
    const run = f.runs[0];
    await run.manualGate.promise;
    if (close) run.userClosed = true;
    else controller.abort();
    run.passed = true;
    await rejected;
    await f.manager.dispose();
    assert.equal(f.saved.length, 0);
    assert(run.closed);
    assert.equal(run.popups, 1);
  });
});

test("无需识别环境即可人工验证，关闭人工验证时不启动窗口", async (t) => {
  const manual = await fixture(t, { managerOptions: { autoEnabled: false, solver: undefined, pollMs: 2 }, captcha: (run) => ({
    capture: async () => { throw Error("人工模式不应调用识别"); }, passed: async () => run.passed,
  }) });
  const task = manual.manager.recover(secret(), rejection());
  await manual.started(1);
  await manual.runs[0].manualGate.promise;
  manual.runs[0].passed = true;
  assert.equal((await task).userId, "a");
  assert.equal(manual.runs[0].popups, 1);
  const disabled = await fixture(t, { managerOptions: { manualFallback: false, timeoutMs: 40, pollMs: 2 }, captcha: unsupportedCaptcha });
  const error = rejection();
  await assert.rejects(disabled.manager.recover(secret(), error), (cause) => cause === error);
  assert.equal(disabled.runs.length, 0);
});

test("会话刷新保留账号名称、启停与默认选择，并拒绝覆盖并发重新登录", async (t) => {
  const root = await directory(t);
  const store = createStore(root, { secureRoot: (path) => mkdir(path, { recursive: true }) });
  await store.save(saveAuth(secret("a")));
  await store.save(saveAuth(secret("b", "OTHER")));
  await store.update("a:0", { name: "用户自定义名称", enabled: false });
  await store.refreshSession("a:0", secret("a", "REFRESHED"), { expectedCookieHeader: secret().cookieHeader });
  const list = await store.list();
  assert.equal(list[0].name, "用户自定义名称");
  assert.equal(list[0].enabled, false);
  assert.equal(list[1].default, true);
  assert.equal((await store.account("a:0", { allowDisabled: true })).secret.cookieHeader, secret("a", "REFRESHED").cookieHeader);
  await store.save(saveAuth(secret("a", "RELOGIN")));
  await assert.rejects(store.refreshSession("a:0", secret("a", "LATE"), { expectedCookieHeader: secret("a", "REFRESHED").cookieHeader }), (e) => e.status === 409);
  assert.equal((await store.account("a:0", { allowDisabled: true })).secret.cookieHeader, secret("a", "RELOGIN").cookieHeader);
});

test("自动恢复后每个请求只重试一次，后续请求使用最新会话并隔离其他账号", async () => {
  const calls = [], recoveries = [];
  const manager = { recover: async (account, _error, options) => {
    recoveries.push({ account, options });
    return secret(account.userId, account.cookieHeader.includes("OLD;") ? "MID" : "NEW");
  } };
  let stage = "MID";
  const raw = { post: async (account, _path, _payload, options) => {
    calls.push({ account, options });
    if (account.userId === "a" && !account.cookieHeader.includes(`sessionid=${stage};`)) throw rejection();
    return new Response("ok");
  } };
  const api = withAutomaticVerification(raw, manager), a = secret("a"), b = secret("b");
  const signal = new AbortController().signal;
  await api.post(a, "/alice/user/launch", {}, { signal });
  stage = "NEW";
  await api.post(a, "/alice/user/launch", {}, { signal });
  await api.post(a, "/alice/user/launch", {}, { signal });
  await api.post(b, "/alice/user/launch", {}, { signal });
  assert.equal(recoveries.length, 2);
  assert.equal(recoveries[0].options.signal, signal);
  assert.equal(calls.at(-2).account.cookieHeader, secret("a", "NEW").cookieHeader);
  assert.equal(calls.at(-1).account, b);
  const alwaysReject = withAutomaticVerification({ post: async () => { throw rejection(); } }, manager);
  await assert.rejects(alwaysReject.post(a, "/alice/user/launch", {}), (e) => e.automaticVerificationAttempted === true);
  assert.equal(recoveries.length, 3);
});

test("SSE 首帧验证拒绝可恢复一次，重发保持账号与原始请求标识", async () => {
  const payloads = [], accounts = [], cleaned = [];
  let recovered = 0;
  const api = {
    catalog,
    post: async (account, _path, payload) => {
      payloads.push(payload); accounts.push(account);
      return payloads.length === 1 ? new Response(verificationFrame) : success();
    },
    recover: async (account, _error, options) => { recovered++; assert.equal(options.onVerification, onVerification); return secret(account.userId, "NEW"); },
  };
  const onVerification = () => {};
  const response = await createCompletion(api, secret(), body, { onVerification, cleanupConversation: async (value) => cleaned.push(value) });
  const text = await response.text();
  assert(text.includes("OK") && text.includes("[DONE]"));
  assert.equal(recovered, 1);
  assert.equal(payloads[0], payloads[1]);
  assert.equal(accounts[0].userId, accounts[1].userId);
  assert.equal(cleaned.length, 1);
});

test("SSE 已有 ACK、会话编号或文本输出时不再重发，连续验证拒绝也停止", async (t) => {
  for (const prefix of [
    frame("SSE_ACK", { ack_client_meta: { conversation_id: "accepted" } }),
    frame("FULL_MSG_NOTIFY", { message: { user_type: 1, conversation_id: "created" } }),
    frame("CHUNK_DELTA", { text: "partial" }),
  ]) await t.test(prefix.split("\n")[0], async () => {
    let posts = 0, recoveries = 0;
    const api = { catalog, post: async () => { posts++; return new Response(prefix + verificationFrame); }, recover: async () => { recoveries++; return secret(); } };
    await assert.rejects(async () => { const response = await createCompletion(api, secret(), body); await response.text(); }, (e) => e.reason === "verification_required");
    assert.equal(posts, 1);
    assert.equal(recoveries, 0);
  });
  let posts = 0, recoveries = 0;
  const api = { catalog, post: async () => { posts++; return new Response(verificationFrame); }, recover: async () => { recoveries++; return secret(); } };
  await assert.rejects(createCompletion(api, secret(), body), (e) => e.reason === "verification_required");
  assert.equal(posts, 2);
  assert.equal(recoveries, 1);
});

test("HTTP 已经恢复后返回的 SSE 验证错误，不会再开启第二次恢复", async () => {
  let posts = 0, recoveries = 0;
  const raw = { catalog, post: async () => { if (++posts === 1) throw rejection(); return new Response(verificationFrame); } };
  const api = withAutomaticVerification(raw, { recover: async () => { recoveries++; return secret("a", "NEW"); } });
  await assert.rejects(createCompletion(api, secret(), body), (e) => e.reason === "verification_required");
  assert.equal(posts, 2);
  assert.equal(recoveries, 1);
});
