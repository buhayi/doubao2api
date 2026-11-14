// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { createGateway } from "../gateway/server.mjs";
import { fail } from "../protocol.mjs";

const KEY = "sk-fixture-0123456789abcdef";
const model = { id: "flash", name: "测试模型", agentMode: 2, modeId: "3", deepThink: 4, extra: {} };
const frame = (event, value) => `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
const upstream = (text = "你好，世界", done = true) => new Response(frame("CHUNK_DELTA", { text }) + (done ? frame("SSE_REPLY_END", {}) : ""), { headers: { "content-type": "text/event-stream" } });
const body = { model: "flash", messages: [{ role: "user", content: "你好" }] };
async function fixture(t, options = {}) {
  const calls = [];
  const api = {
    catalog: async (secret) => { calls.push(["catalog", secret]); return { bot: "BOT", models: { flash: model } }; },
    post: async (...args) => { calls.push(["post", ...args]); return upstream(); },
    usage: async () => ({ windows: [{ name: "5 小时", used: 20 }] }),
    ...options.api,
  };
  const store = options.store || { account: async (uid) => ({ uid: uid || "u:0", secret: { cookieHeader: "sessionid=PRIVATE_FIXTURE" } }) };
  const apiKey = options.apiKey ?? KEY;
  const gateway = createGateway({ store, apiKey, hideHistory: false, ...options, api });
  gateway.server.listen(0, "127.0.0.1");
  await once(gateway.server, "listening");
  t.after(() => gateway.close());
  const url = `http://127.0.0.1:${gateway.server.address().port}`;
  const call = (path, init = {}) => fetch(url + path, { ...init, headers: { Authorization: `Bearer ${apiKey}`, ...init.headers } });
  const chat = (value = body, init = {}) => call("/v1/chat/completions", { method: "POST", body: JSON.stringify(value), ...init, headers: { "Content-Type": "application/json", ...init.headers } });
  return { gateway, api, calls, url, call, chat };
}

test("网关：健康检查无敏感信息；所有 API 必须鉴权且不访问上游", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await (await fetch(f.url + "/health")).json(), { status: "ok" });
  for (const headers of [{}, { Authorization: "Bearer WRONG" }, { Authorization: KEY }, { "X-API-Key": "WRONG" }]) {
    const response = await fetch(f.url + "/v1/models", { headers });
    assert.equal(response.status, 401);
    const text = await response.text();
    assert.match(text, /invalid_api_key/);
    assert(!text.includes(KEY) && !text.includes("PRIVATE_FIXTURE"));
  }
  assert.equal(f.calls.length, 0);
  assert.equal((await fetch(f.url + "/v1/models", { headers: { "X-API-Key": KEY } })).status, 200);
});

test("网关：任意自定义短密钥、符号和内部空格可鉴权，错误或缺失密钥仍返回 401", async (t) => {
  for (const key of ["a", "123", "test", "custom key #+/:=!", "x".repeat(1024)]) {
    await t.test(key.length > 256 ? "长密钥" : key, async (t) => {
      const f = await fixture(t, { apiKey: key });
      for (const headers of [{}, { Authorization: "Bearer" }, { Authorization: key }, { Authorization: `Bearer ${key}_wrong` }, { "X-API-Key": `${key}_wrong` }]) {
        const response = await fetch(f.url + "/v1/models", { headers });
        assert.equal(response.status, 401);
        assert.equal((await response.json()).error.code, "invalid_api_key");
      }
      assert.equal(f.calls.length, 0);
      for (const headers of [{ Authorization: `Bearer ${key}` }, { Authorization: `bearer ${key}` }, { "X-API-Key": key }]) {
        const response = await fetch(f.url + "/v1/models", { headers });
        assert.equal(response.status, 200);
        assert.equal((await response.json()).object, "list");
      }
      const response = await f.chat();
      assert.equal(response.status, 200);
      assert.equal((await response.json()).object, "chat.completion");
    });
  }
});

test("网关：API Key 大小写和内部空格必须与配置完全一致", async (t) => {
  const f = await fixture(t, { apiKey: "Test key" });
  for (const key of ["test key", "Test  key", "Testkey"]) {
    for (const headers of [{ Authorization: `Bearer ${key}` }, { "X-API-Key": key }]) {
      const response = await fetch(f.url + "/v1/models", { headers });
      assert.equal(response.status, 401);
      await response.json();
    }
  }
  assert.equal(f.calls.length, 0);
});

test("网关：标准模型列表、模型详情和额度；支持固定账号", async (t) => {
  const f = await fixture(t, { accountId: "fixed:0" });
  const list = await (await f.call("/v1/models/")).json();
  assert.equal(list.object, "list");
  assert.deepEqual(list.data.map((m) => m.id), ["flash"]);
  assert.equal((await (await f.call("/v1/models/flash")).json()).object, "model");
  assert.equal((await f.call("/v1/models/missing")).status, 404);
  assert.equal((await f.call("/v1/models/%zz")).status, 400);
  assert.equal((await (await f.call("/v1/usage")).json()).windows[0].used, 20);
  assert(!JSON.stringify(list).includes("PRIVATE_FIXTURE"));
});

test("网关：默认非流式 JSON，与 OpenAI Chat Completions 响应一致", async (t) => {
  const f = await fixture(t);
  const response = await f.chat();
  assert.match(response.headers.get("content-type"), /application\/json/);
  const result = await response.json();
  assert.equal(result.object, "chat.completion");
  assert.equal(result.model, "flash");
  assert.equal(result.choices[0].message.content, "你好，世界");
  assert.equal(result.choices[0].finish_reason, "stop");
  assert.equal(result.usage, undefined); // Do not invent upstream token usage.
  const post = f.calls.find((c) => c[0] === "post");
  assert.equal(post[2], "/chat/completion");
  assert(!JSON.stringify(post).includes(KEY));
});

test("网关：SSE 保留中文、角色、结束原因及单个 DONE", async (t) => {
  const f = await fixture(t);
  const response = await f.chat({ ...body, stream: true });
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  assert.equal(response.headers.get("x-accel-buffering"), "no");
  const text = await response.text();
  assert.match(text, /你好，世界/);
  assert.match(text, /"role":"assistant"/);
  assert.match(text, /"finish_reason":"stop"/);
  assert.equal(text.split("[DONE]").length, 2);
});

test("网关：错误方法、接口、正文和模型都返回结构化错误", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.call("/v1/chat/completions")).status, 405);
  assert.equal((await f.call("/v1/models", { method: "POST" })).headers.get("allow"), "GET");
  assert.equal((await f.call("/unknown")).status, 404);
  assert.equal((await f.call("/v1/responses")).status, 405);
  assert.equal((await f.chat(body, { body: "{" })).status, 400);
  assert.equal((await f.chat(body, { headers: { "Content-Type": "text/plain" } })).status, 415);
  for (const value of [null, [], {}, { ...body, messages: [] }, { ...body, stream: "true" }, { ...body, n: 2 }])
    assert.equal((await f.chat(value)).status, 400);
  assert.equal((await f.chat({ ...body, model: "missing" })).status, 404);
  assert.equal((await f.chat({ ...body, messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.test/image" } }] }] })).status, 400);
  assert.equal(f.calls.filter((c) => c[0] === "post").length, 0);
});

test("网关：有 Content-Length 或分块传输的超大正文都被拒绝", async (t) => {
  const f = await fixture(t);
  const large = JSON.stringify({ ...body, extra: "x".repeat(2 * 1024 * 1024) });
  assert.equal((await f.chat(body, { body: large })).status, 413);
  const status = await new Promise((resolve, reject) => {
    const req = request(f.url + "/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    for (let offset = 0; offset < large.length; offset += 65536) req.write(large.slice(offset, offset + 65536));
    req.end();
  });
  assert.equal(status, 413);
  assert.equal(f.calls.length, 0);
});

test("网关：CORS 默认禁止；允许来源预检不触发上游；浏览器仍需 API Key", async (t) => {
  const f = await fixture(t, { corsOrigins: ["https://chat.example.test"] });
  assert.equal((await f.call("/v1/models", { headers: { Origin: "https://evil.example.test" } })).status, 403);
  const preflight = await fetch(f.url + "/v1/chat/completions", { method: "OPTIONS", headers: { Origin: "https://chat.example.test", "Access-Control-Request-Headers": "authorization,content-type" } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "https://chat.example.test");
  assert(preflight.headers.get("access-control-expose-headers").split(/,\s*/).some((name) => name.toLowerCase() === "x-doubao-history"));
  assert.equal(f.calls.length, 0);
  assert.equal((await fetch(f.url + "/v1/models", { headers: { Origin: "https://chat.example.test" } })).status, 401);
  const denied = await fixture(t);
  assert.equal((await denied.call("/v1/models", { headers: { Origin: "https://chat.example.test" } })).status, 403);
});

test("网关：未登录、会话过期和未知错误不会泄露凭据", async (t) => {
  const empty = await fixture(t, { store: { account: async () => { throw fail(503, "请运行 npm run login。"); } } });
  assert.equal((await empty.chat()).status, 503);
  const expired = await fixture(t, { api: { catalog: async () => { throw Object.assign(fail(401, "会话失效，请重新登录。"), { reason: "session_expired" }); } } });
  assert.equal((await (await expired.chat()).json()).error.code, "session_expired");
  const broken = await fixture(t, { api: { post: async () => { throw Error("PRIVATE_FIXTURE_COOKIE"); } } });
  const response = await broken.chat();
  assert.equal(response.status, 502);
  assert(!(await response.text()).includes("PRIVATE_FIXTURE"));
});

test("网关：非流式截断上游报错而非伪造成功", async (t) => {
  const f = await fixture(t, { api: { post: async () => upstream("partial", false) } });
  const response = await f.chat();
  assert.equal(response.status, 502);
  assert.match((await response.json()).error.message, /结束标记/);
});

test("网关：实验性工具桥通过真实 HTTP 返回工具，关闭后明确拒绝", async (t) => {
  const tools = [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }];
  const f = await fixture(t, { api: { post: async (_secret, _path, payload) => {
    const prompt = payload.messages[0].content_block[0].content.text_block.text;
    const marker = prompt.match(/magpie_doubaowork_tools_[a-f0-9]+/)[0];
    return upstream(JSON.stringify({ [marker]: [{ name: "lookup", arguments: { value: "中文" } }] }));
  } } });
  const result = await (await f.chat({ ...body, tools, tool_choice: "required" })).json();
  assert.equal(result.choices[0].finish_reason, "tool_calls");
  assert.equal(result.choices[0].message.tool_calls[0].function.name, "lookup");
  const stream = await (await f.chat({ ...body, tools, stream: true })).text();
  assert.match(stream, /"index":0/);
  assert.match(stream, /\[DONE\]/);
  const disabled = await fixture(t, { promptTools: false });
  assert.equal((await disabled.chat({ ...body, tools })).status, 400);
});

test("网关：并发保护；客户端断开取消上游，释放账号容量", async (t) => {
  let cancelled;
  const observed = new Promise((resolve) => { cancelled = resolve; });
  let number = 0;
  const f = await fixture(t, { maxConcurrency: 1, api: { post: async (_secret, _path, _payload, { signal }) => {
    if (++number > 1) return upstream("再次请求");
    signal.addEventListener("abort", cancelled, { once: true });
    return new Response(new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode(frame("CHUNK_DELTA", { text: "partial" }))); },
      cancel() { cancelled(); },
    }), { headers: { "content-type": "text/event-stream" } });
  } } });
  const controller = new AbortController();
  const first = await f.chat({ ...body, stream: true }, { signal: controller.signal });
  const reader = first.body.getReader();
  assert.equal((await reader.read()).done, false);
  const busy = await f.chat();
  assert.equal(busy.status, 429);
  assert.equal(busy.headers.get("retry-after"), "1");
  controller.abort();
  await Promise.race([observed, delay(3000).then(() => { throw Error("上游没有取消"); })]);
  let retry;
  for (let i = 0; i < 20; i++) {
    retry = await f.chat();
    if (retry.status !== 429) break;
    await delay(10);
  }
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).choices[0].message.content, "再次请求");
});

test("网关：请求超时返回 504，无自动重复上游请求", async (t) => {
  let count = 0;
  const f = await fixture(t, { timeoutMs: 40, api: { post: async (_secret, _path, _payload, { signal }) => {
    count++;
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  } } });
  const response = await f.chat();
  assert.equal(response.status, 504);
  assert.equal((await response.json()).error.code, "request_timeout");
  assert.equal(count, 1);
});

test("网关：流中途断开不输出伪造 DONE；关停取消活跃流", async (t) => {
  let source;
  let abortObserved;
  const stopped = new Promise((resolve) => { abortObserved = resolve; });
  const f = await fixture(t, { api: { post: async (_secret, _path, _payload, { signal }) => {
    signal.addEventListener("abort", abortObserved, { once: true });
    return new Response(new ReadableStream({ start(c) { source = c; c.enqueue(new TextEncoder().encode(frame("CHUNK_DELTA", { text: "partial" }))); } }), { headers: { "content-type": "text/event-stream" } });
  } } });
  const response = await f.chat({ ...body, stream: true });
  const reader = response.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert(!first.includes("[DONE]"));
  source.close();
  await assert.rejects(reader.read());
  const live = await f.chat({ ...body, stream: true });
  const liveReader = live.body.getReader();
  await liveReader.read();
  await f.gateway.close();
  await Promise.race([stopped, delay(3000).then(() => { throw Error("关停没有取消上游"); })]);
  await assert.rejects(liveReader.read());
});

test("网关：客户端中途终止上传不造成未处理异常，服务继续响应", async (t) => {
  const f = await fixture(t);
  await new Promise((resolve, reject) => {
    const req = request(f.url + "/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" } });
    req.on("error", () => {});
    req.once("socket", (socket) => {
      socket.once("connect", () => {
        req.write('{"model":"flash","messages":[');
        setImmediate(() => req.destroy());
      });
    });
    req.once("close", resolve);
    req.once("response", () => reject(Error("不完整请求不应开始对话")));
  });
  assert.equal((await f.call("/health")).status, 200);
  assert.equal((await f.chat()).status, 200);
});


test("网关：上游首帧或响应头迟迟未到时发送 SSE 心跳，不伪造回答", async (t) => {
  let deliver, postCalls = 0;
  const f = await fixture(t, { heartbeatMs: 20, api: { post: async () => { postCalls++; return new Promise((resolve) => { deliver = resolve; }); } } });
  const response = await f.chat({ ...body, stream: true }, { signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const reader = response.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /: keep-alive/);
  assert(!first.includes("choices") && !first.includes("[DONE]"));
  deliver(upstream("真实回答"));
  let text = first;
  for (;;) { const part = await reader.read(); if (part.done) break; text += new TextDecoder().decode(part.value); }
  assert.match(text, /真实回答/);
  assert.equal(text.split("[DONE]").length, 2);
  assert.equal(postCalls, 1);
});

test("网关：已有回答后长时间思考也持续发心跳", async (t) => {
  let source;
  const f = await fixture(t, { heartbeatMs: 20, api: { post: async () => new Response(new ReadableStream({
    start(c) { source = c; c.enqueue(new TextEncoder().encode(frame("CHUNK_DELTA", { text: "首段" }))); },
  }), { headers: { "content-type": "text/event-stream" } }) } });
  const response = await f.chat({ ...body, stream: true }, { signal: AbortSignal.timeout(3000) });
  const reader = response.body.getReader();
  let text = new TextDecoder().decode((await reader.read()).value);
  assert.match(text, /首段/);
  const next = new TextDecoder().decode((await reader.read()).value);
  assert.match(next, /: keep-alive/);
  text += next;
  source.enqueue(new TextEncoder().encode(frame("CHUNK_DELTA", { text: "尾段" }) + frame("SSE_REPLY_END", {})));
  source.close();
  for (;;) { const part = await reader.read(); if (part.done) break; text += new TextDecoder().decode(part.value); }
  assert.match(text, /尾段/);
  assert.equal(text.split("[DONE]").length, 2);
});

test("网关：心跳不延长总超时，超时发送 SSE 错误且释放并发容量", async (t) => {
  let cancelled = false, count = 0;
  const f = await fixture(t, { timeoutMs: 500, heartbeatMs: 20, api: { post: async () => {
    if (++count > 1) return upstream("下一次回答");
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-type": "text/event-stream" } });
  } } });
  const response = await f.chat({ ...body, stream: true }, { signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 200); // An earlier heartbeat committed the SSE headers.
  const text = await response.text();
  assert.match(text, /: keep-alive/);
  assert.match(text, /"code":"request_timeout"/);
  assert(!text.includes("[DONE]"));
  assert(cancelled);
  const again = await f.chat();
  assert.equal(again.status, 200);
  assert.equal((await again.json()).choices[0].message.content, "下一次回答");
  assert.equal(count, 2);
});

test("网关：心跳后上游拒绝请求返回错误事件，立即拒绝仍保留 HTTP 状态", async (t) => {
  let rejectPost;
  const f = await fixture(t, { heartbeatMs: 20, api: { post: async () => new Promise((_resolve, reject) => { rejectPost = reject; }) } });
  const response = await f.chat({ ...body, stream: true }, { signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 200);
  rejectPost(fail(429, "上游限流。"));
  const text = await response.text();
  assert.match(text, /"code":"rate_limited"/);
  assert(!text.includes("[DONE]"));
  const fast = await fixture(t, { api: { post: async () => { throw fail(429, "上游限流。"); } } });
  const denied = await fast.chat({ ...body, stream: true });
  assert.equal(denied.status, 429);
  assert.equal((await denied.json()).error.code, "rate_limited");
});
