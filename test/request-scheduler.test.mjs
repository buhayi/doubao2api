// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequestScheduler, retryAfterMilliseconds } from "../request-scheduler.mjs";
import { createApi, vendorError } from "../protocol.mjs";
import { createCompletion } from "../completion.mjs";
import { createGateway } from "../gateway/server.mjs";
import { createAdmin } from "../gateway/admin.mjs";
import { createHistoryCleaner } from "../gateway/history.mjs";
import { isUpstreamFailure } from "../gateway/account-health.mjs";
import { loadConfig } from "../gateway/config.mjs";

const secret = { userId: "a", enterpriseType: "0", cookieHeader: "sessionid=PRIVATE_PACING_COOKIE", name: "测试账号" };
const other = { ...secret, userId: "b", cookieHeader: "sessionid=PRIVATE_OTHER_COOKIE" };
const model = { id: "flash", name: "Flash", agentMode: 2, modeId: "3", deepThink: 0, extra: {} };
const catalog = { code: 0, data: { entry_list: [{ active_switch_conf: {
  menu_conf: { item_list: [{ model_item_key: "flash", name: "Flash", agent_mode: 2, default_mode: "3" }] },
} }] } };
const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
function metadata(url) {
  const path = new URL(url).pathname;
  if (path === "/alice/user/launch") return Response.json({ code: 0, data: { assistant_bot_id: "BOT" } });
  if (path === "/alice/slot/action_bar_v3/brief_list") return Response.json(catalog);
  return Response.json({ code: 0, data: {} });
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("上游调度：同账号串行，不同账号独立，释放幂等", async () => {
  const scheduler = createRequestScheduler({ minIntervalMs: 0 });
  const first = await scheduler.acquire("a");
  const waiting = scheduler.acquire("a");
  const secondAccount = await scheduler.acquire("b");
  assert.equal(scheduler.status().active, 2);
  assert.equal(scheduler.status().queued, 1);
  secondAccount(); first(); first();
  const second = await waiting;
  assert.equal(scheduler.status().active, 1);
  second();
  assert.equal(scheduler.status().active, 0);
});

test("上游调度：短请求也保持开始时间间隔", async () => {
  const scheduler = createRequestScheduler({ minIntervalMs: 40 });
  const first = await scheduler.acquire("a");
  const began = Date.now();
  first();
  const second = await scheduler.acquire("a");
  assert(Date.now() - began >= 39);
  second();
});

test("上游调度：取消等待者不占槽、不打乱后续请求", async () => {
  const scheduler = createRequestScheduler({ minIntervalMs: 0 });
  const first = await scheduler.acquire("a");
  const controller = new AbortController();
  const cancelled = assert.rejects(scheduler.acquire("a", { signal: controller.signal }), error => error.name === "AbortError");
  const next = scheduler.acquire("a");
  controller.abort();
  await cancelled;
  assert.equal(scheduler.status().queued, 1);
  first(); (await next)();
  assert.equal(scheduler.status().queued, 0);
});

test("上游调度：队列有界，本地排队拒绝不使账号失效", async () => {
  const scheduler = createRequestScheduler({ minIntervalMs: 0, maxQueuedRequests: 1 });
  const first = await scheduler.acquire("a");
  const waiting = scheduler.acquire("a");
  await assert.rejects(scheduler.acquire("a"), error => error.status === 429 && error.localRateLimit && !isUpstreamFailure(error));
  first(); (await waiting)();
});

test("上游调度：限流停止已排队请求，冷却结束前不重新访问", async () => {
  let clock = 100;
  const scheduler = createRequestScheduler({ minIntervalMs: 0, now: () => clock });
  const first = await scheduler.acquire("a");
  const error = vendorError(429);
  const waiting = assert.rejects(scheduler.acquire("a"), value => value === error);
  scheduler.cooldown("a", 5000, error);
  first();
  await waiting;
  await assert.rejects(scheduler.acquire("a"), value => value.upstreamCooldown && value.retryAfterSeconds === 5);
  clock += 5000;
  (await scheduler.acquire("a"))();
});

test("Retry-After：秒数、HTTP 日期和无效值", () => {
  const now = Date.parse("2026-11-16T12:00:00Z");
  assert.equal(retryAfterMilliseconds("12", now), 12000);
  assert.equal(retryAfterMilliseconds("Mon, 16 Nov 2026 12:00:15 GMT", now), 15000);
  assert.equal(retryAfterMilliseconds("0", now), 0);
  for (const value of [undefined, "", "-1", "1.5", "invalid"]) {
    assert.equal(retryAfterMilliseconds(value, now), undefined);
    assert.equal(retryAfterMilliseconds(value, 0), undefined);
  }
  assert.equal(retryAfterMilliseconds("Mon, 16 Nov 2026 11:59:59 GMT", now), undefined);
});

test("上游流：收到首段不释放账号，完整读取后才开始排队请求", async () => {
  let source, calls = 0;
  const api = createApi({ minIntervalMs: 0, fetchImpl: async () => {
    if (++calls > 1) return Response.json({ code: 0 });
    return new Response(new ReadableStream({ start(controller) { source = controller; controller.enqueue(new TextEncoder().encode("first")); } }),
      { headers: { "content-type": "text/event-stream" } });
  } });
  const stream = await api.post(secret, "/chat/completion", {}, { stream: true });
  const reader = stream.body.getReader();
  await reader.read();
  const waiting = api.post({ ...secret, cookieHeader: "sessionid=PRIVATE_NEW_LOGIN" }, "/alice/user/launch", {});
  assert.equal(api.requestStatus().queued, 1);
  assert.equal(calls, 1);
  source.close();
  assert.equal((await reader.read()).done, true);
  await waiting;
  assert.equal(calls, 2);
  assert.equal(api.requestStatus().active, 0);
});

test("上游流：取消和超时信号释放账号，不发送已取消的排队请求", async () => {
  let calls = 0, cancelled = 0;
  const api = createApi({ minIntervalMs: 0, fetchImpl: async () => {
    if (++calls > 1) return Response.json({ code: 0 });
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); }, cancel() { cancelled++; } }),
      { headers: { "content-type": "text/event-stream" } });
  } });
  const controller = new AbortController(), queued = new AbortController();
  const stream = await api.post(secret, "/chat/completion", {}, { stream: true, signal: controller.signal });
  const rejected = assert.rejects(api.post(secret, "/alice/user/launch", {}, { signal: queued.signal }), error => error.status === 499);
  queued.abort();
  await rejected;
  const next = api.post(secret, "/alice/user/launch", {});
  controller.abort();
  await assert.rejects(stream.text());
  await next;
  assert.equal(cancelled, 1);
  assert.equal(calls, 2);
});

test("上游限流：透传 Retry-After，重复错误通知不延长冷却，新登录也遵守同账号冷却", async () => {
  let clock = 100, calls = 0, original;
  const api = createApi({ minIntervalMs: 0, now: () => clock, fetchImpl: async () => ++calls === 1
    ? Response.json({ error_code: 710022004 }, { status: 429, headers: { "Retry-After": "5" } }) : Response.json({ code: 0 }) });
  await assert.rejects(api.post(secret, "/chat/completion", {}, { stream: true }), error => { original = error; return error.retryAfterSeconds === 5; });
  api.reportFailure(secret, original);
  await assert.rejects(api.post({ ...secret, cookieHeader: "sessionid=PRIVATE_NEW_SESSION" }, "/alice/user/launch", {}), error => error.retryAfterSeconds === 5);
  assert.equal(calls, 1);
  assert.equal((await api.post(other, "/alice/user/launch", {})).code, 0);
  clock += 5000;
  assert.equal((await api.post(secret, "/alice/user/launch", {})).code, 0);
});

test("上游限流：HTTP 200 业务错误使用冷却默认值，非 JSON 429 保留 Retry-After", async () => {
  for (const [response, expected] of [
    [() => Response.json({ code: 710022004 }), 60],
    [() => new Response("PRIVATE_REJECTION_BODY", { status: 429, headers: { "Retry-After": "7" } }), 7],
  ]) {
    let calls = 0;
    const api = createApi({ minIntervalMs: 0, fetchImpl: async () => { calls++; return response(); } });
    await assert.rejects(api.post(secret, "/alice/user/launch", {}), error => error.reason === "rate_limited" && error.retryAfterSeconds === expected && !error.message.includes("PRIVATE_REJECTION_BODY"));
    await assert.rejects(api.post(secret, "/alice/user/launch", {}), error => error.upstreamCooldown);
    assert.equal(calls, 1);
  }
});

test("身份核验：HTTP 200 的业务限流保留 429 分类并停止再次查询", async t => {
  for (const body of [{ error_code: 710022004 }, { code: 710022004 }]) await t.test(JSON.stringify(body), async () => {
    let calls = 0;
    const api = createApi({ minIntervalMs: 0, fetchImpl: async () => {
      calls++;
      return Response.json(body, { headers: { "Retry-After": "4" } });
    } });
    await assert.rejects(api.identify(secret), error => error.status === 429 && error.reason === "rate_limited" && error.retryAfterSeconds === 4);
    await assert.rejects(api.identify(secret), error => error.upstreamCooldown);
    assert.equal(calls, 1);
  });
});

test("额度查询：合并并发请求，缓存按凭据隔离，可过期或显式刷新", async () => {
  let calls = 0, clock = 0;
  const api = createApi({ minIntervalMs: 0, now: () => clock, fetchImpl: async url => { calls++; return metadata(url); } });
  await Promise.all([api.usage(secret), api.usage(secret), api.usage(secret)]);
  assert.equal(calls, 2);
  await api.usage(secret);
  assert.equal(calls, 2);
  await api.usage(other);
  assert.equal(calls, 4);
  clock = 30000;
  await api.usage(secret);
  assert.equal(calls, 6);
  await api.usage(secret, { force: true });
  assert.equal(calls, 8);
  assert(!JSON.stringify(api.requestStatus()).includes("PRIVATE"));
});

test("共享查询：单个调用方取消不取消其他调用方的目录或额度", async t => {
  for (const method of ["catalog", "usage"]) await t.test(method, async () => {
    const started = deferred(), reply = deferred();
    let calls = 0, upstreamSignal;
    const api = createApi({ minIntervalMs: 0, fetchImpl: async (url, { signal }) => {
      calls++;
      if (calls === 1) { upstreamSignal = signal; started.resolve(); await reply.promise; }
      return metadata(url);
    } });
    const controller = new AbortController();
    const cancelled = api[method](secret, { signal: controller.signal });
    const keeper = api[method](secret);
    await started.promise;
    const rejection = assert.rejects(cancelled, error => error.status === 499);
    controller.abort();
    await rejection;
    assert.equal(upstreamSignal.aborted, false);
    reply.resolve();
    await keeper;
    await api[method](secret);
    assert.equal(calls, 2);
  });
});

test("共享查询：所有调用方取消后不缓存结果，新查询使用新任务", async () => {
  const started = deferred();
  let calls = 0;
  const api = createApi({ minIntervalMs: 0, fetchImpl: async (url, { signal }) => {
    if (++calls === 1) {
      started.resolve();
      await new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    }
    return metadata(url);
  } });
  const a = new AbortController(), b = new AbortController();
  const first = assert.rejects(api.usage(secret, { signal: a.signal }), error => error.status === 499);
  const second = assert.rejects(api.usage(secret, { signal: b.signal }), error => error.status === 499);
  await started.promise;
  a.abort(); b.abort();
  await Promise.all([first, second]);
  await api.usage(secret);
  assert.equal(calls, 3);
});

test("额度查询：附加配置的限流不被当作成功缓存", async () => {
  let calls = 0;
  const api = createApi({ minIntervalMs: 0, fetchImpl: async url => {
    calls++;
    return new URL(url).pathname.endsWith("/entry/config/") ? Response.json({ code: 710022004 }) : metadata(url);
  } });
  await assert.rejects(api.usage(secret), error => error.reason === "rate_limited");
  await assert.rejects(api.usage(secret), error => error.upstreamCooldown);
  assert.equal(calls, 2);
});

test("SSE 业务限流：停止排队请求，后续调用不再次发送", async () => {
  let calls = 0;
  const api = createApi({ minIntervalMs: 0, fetchImpl: async url => {
    calls++;
    return new URL(url).pathname === "/chat/completion"
      ? new Response(frame("SSE_ERROR", { code: 710022004 }), { headers: { "content-type": "text/event-stream" } }) : metadata(url);
  } });
  await assert.rejects(createCompletion(api, secret, { model: "flash", messages: [{ role: "user", content: "fixture" }], stream: false }), error => error.reason === "rate_limited" && error.retryAfterSeconds === 60);
  await assert.rejects(api.post(secret, "/chat/completion", {}, { stream: true }), error => error.upstreamCooldown);
  assert.equal(calls, 3);
});

test("SSE 业务限流：HTTP 200 的 Retry-After 秒数和日期优先于默认冷却", async t => {
  const now = Date.parse("2026-11-16T12:00:00Z");
  for (const header of ["6", "Mon, 16 Nov 2026 12:00:06 GMT"]) await t.test(header, async () => {
    const api = createApi({ minIntervalMs: 0, now: () => now, fetchImpl: async url =>
      new URL(url).pathname === "/chat/completion"
        ? new Response(frame("SSE_ERROR", { code: 710022004 }), { headers: { "content-type": "text/event-stream", "Retry-After": header } })
        : metadata(url),
    });
    await assert.rejects(createCompletion(api, secret, {
      model: "flash", messages: [{ role: "user", content: "fixture" }], stream: false,
    }), error => error.retryAfterSeconds === 6);
    await assert.rejects(api.post(secret, "/chat/completion", {}, { stream: true }), error => error.upstreamCooldown && error.retryAfterSeconds === 6);
  });
});

test("SSE 拒绝：先停止已排队请求，再释放流式请求账号", async t => {
  for (const [value, reason] of [
    [{ code: 710022004 }, "rate_limited"],
    [{ code: 710022004, extra: { decision: { type: "verify" } } }, "verification_required"],
  ]) await t.test(reason, async () => {
    const started = deferred();
    let source, calls = 0;
    const api = createApi({ minIntervalMs: 0, fetchImpl: async url => {
      calls++;
      if (new URL(url).pathname !== "/chat/completion") return metadata(url);
      return new Response(new ReadableStream({ start(controller) { source = controller; started.resolve(); } }),
        { headers: { "content-type": "text/event-stream" } });
    } });
    await api.catalog(secret);
    const completion = assert.rejects(createCompletion(api, secret, {
      model: "flash", messages: [{ role: "user", content: "fixture" }], stream: false,
    }), error => error.reason === reason);
    await started.promise;
    const waiting = assert.rejects(api.post(secret, "/alice/user/launch", {}), error => error.reason === reason);
    const rejected = Promise.all([completion, waiting]);
    assert.equal(api.requestStatus().queued, 1);
    source.enqueue(new TextEncoder().encode(frame("SSE_ERROR", value)));
    source.close();
    await rejected;
    assert.equal(calls, 3);
    assert.equal(api.requestStatus().active, 0);
  });
});

test("会话清理：先删除刚结束的回复，再开始排队的长回复", async t => {
  const started = deferred(), paths = [];
  let source;
  const api = createApi({ minIntervalMs: 0, maxQueuedRequests: 1, fetchImpl: async url => {
    const path = new URL(url).pathname;
    paths.push(path);
    if (path !== "/chat/completion") return metadata(url);
    return new Response(new ReadableStream({ start(controller) {
      if (!source) { source = controller; started.resolve(); }
    } }), { headers: { "content-type": "text/event-stream" } });
  } });
  const cleaner = createHistoryCleaner({ api, timeoutMs: 500, logger: () => {} });
  const completion = createCompletion(api, secret, {
    model: "flash", messages: [{ role: "user", content: "fixture" }], stream: false,
  }, { cleanupConversation: conversation => cleaner.clean(secret, conversation) });
  await started.promise;
  const waiting = api.post(secret, "/chat/completion", {}, { stream: true });
  t.after(async () => (await waiting).body.cancel());
  source.enqueue(new TextEncoder().encode(
    frame("SSE_ACK", { ack_client_meta: { bot_id: "BOT", conversation_id: "fixture-conversation" } })
    + frame("CHUNK_DELTA", { text: "fixture reply" })
    + frame("SSE_REPLY_END", {}),
  ));
  source.close();
  assert.equal((await (await completion).json()).choices[0].message.content, "fixture reply");
  assert.equal(cleaner.status().deleted, 1);
  await waiting;
  assert.deepEqual(paths.slice(-2), ["/im/conversation/batch_del_user_conv", "/chat/completion"]);
});

test("API 配置：默认节奏、禁用缓存及参数校验", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "doubao-request-policy-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const config = await loadConfig({ cwd, env: {} });
  assert.equal(config.upstreamMinIntervalMs, 1000);
  assert.equal(config.upstreamQueueLimit, 16);
  assert.equal(config.rateLimitCooldownMs, 60000);
  assert.equal(config.usageCacheTtlMs, 30000);
  for (const env of [{ DW_UPSTREAM_MIN_INTERVAL_MS: "-1" }, { DW_UPSTREAM_QUEUE_LIMIT: "129" }, { DW_RATE_LIMIT_COOLDOWN_MS: "0" }, { DW_USAGE_CACHE_TTL_MS: "300001" }])
    await assert.rejects(loadConfig({ cwd, env }));
  assert.throws(() => createApi({ minIntervalMs: -1 }));
  assert.throws(() => createApi({ maxQueuedRequests: 129 }));
  assert.throws(() => createApi({ usageTtlMs: -1 }));
  assert.throws(() => createApi({ rateLimitCooldownMs: 0 }));
});

test("客户端协议：Chat、Responses、Claude 均返回上游等待时间", async t => {
  const requests = [
    ["/v1/chat/completions", { model: "flash", messages: [{ role: "user", content: "fixture" }] }],
    ["/v1/responses", { model: "flash", input: "fixture" }],
    ["/v1/messages", { model: "flash", messages: [{ role: "user", content: "fixture" }], max_tokens: 128 }],
  ];
  for (const [path, body] of requests) await t.test(path, async t => {
    const api = createApi({ minIntervalMs: 0, fetchImpl: async url => new URL(url).pathname === "/chat/completion"
      ? Response.json({ code: 710022004 }, { status: 429, headers: { "Retry-After": "9" } }) : metadata(url) });
    const gateway = createGateway({ api, apiKey: "pacing-test", deleteHistory: false, heartbeatMs: 0,
      store: { account: async () => ({ uid: "a:0", secret }) } });
    t.after(() => gateway.close());
    gateway.server.listen(0, "127.0.0.1");
    await once(gateway.server, "listening");
    const response = await fetch(`http://127.0.0.1:${gateway.server.address().port}${path}`, {
      method: "POST", headers: { Authorization: "Bearer pacing-test", "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "9");
    assert.equal((await response.json()).error.type, "rate_limit_error");
  });
});

test("管理台：本地排队拒绝不把正常账号归入失效", async t => {
  for (const action of ["check", "probe", "models"]) await t.test(action, async t => {
    const writes = [], error = Object.assign(new Error("本地队列已满"), { status: 429, localRateLimit: true, retryAfterSeconds: 1 });
    const api = { identify: async () => { throw error; }, catalog: async () => {
      if (action === "models") throw error;
      return { bot: "BOT", models: { flash: model } };
    }, post: async () => { throw error; } };
    const account = { uid: "a:0", updatedAt: 1, auth: { access: "fixture" }, secret };
    const admin = createAdmin({ api, apiKey: "pacing-test", config: { deleteHistory: false },
      store: { root: "fixture", list: async () => [account], account: async () => account, recordHealth: async (...args) => writes.push(args) } });
    t.after(() => admin.close());
    admin.server.listen(0, "127.0.0.1");
    await once(admin.server, "listening");
    const url = `http://127.0.0.1:${admin.server.address().port}`;
    const { token } = await (await fetch(url + "/api/session")).json();
    const response = await fetch(`${url}/api/accounts/a%3A0/${action}`, { method: action === "models" ? "GET" : "POST",
      headers: { Origin: url, "X-Doubao-Admin": token, "Content-Type": "application/json" },
      ...(action === "models" ? {} : { body: "{}" }),
    });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "1");
    await response.json();
    assert.equal(writes.length, 0);
  });
});
