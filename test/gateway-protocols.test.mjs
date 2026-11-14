// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { createGateway } from "../gateway/server.mjs";
import { fail } from "../protocol.mjs";

const KEY = "protocol-fixture-key";
const model = { id: "flash", name: "测试模型", agentMode: 2, modeId: "3", deepThink: 4, extra: {} };
const frame = (event, value) => `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
const upstream = (text = "你好，世界", done = true) => new Response(frame("CHUNK_DELTA", { text }) + (done ? frame("SSE_REPLY_END", {}) : ""), { headers: { "content-type": "text/event-stream" } });
const responsesBody = { model: "flash", input: "你好" };
const messagesBody = { model: "flash", max_tokens: 1024, messages: [{ role: "user", content: "你好" }] };
function events(text) {
  return text.split(/\r?\n\r?\n/).filter((part) => /^event:/m.test(part)).map((part) => {
    const event = part.match(/^event: (.+)$/m)[1];
    const data = JSON.parse(part.match(/^data: (.+)$/m)[1]);
    assert.equal(event, data.type);
    return { event, data };
  });
}
async function fixture(t, options = {}) {
  const calls = [];
  const api = {
    catalog: async () => ({ bot: "BOT", models: { flash: model } }),
    post: async (_secret, _path, payload) => { calls.push(payload); return upstream(); },
    ...options.api,
  };
  const store = options.store || { account: async () => ({ uid: "test:0", secret: { cookieHeader: "sessionid=PRIVATE_PROTOCOL_FIXTURE" } }) };
  const gateway = createGateway({ store, apiKey: KEY, heartbeatMs: 0, hideHistory: false, ...options, api });
  gateway.server.listen(0, "127.0.0.1");
  await once(gateway.server, "listening");
  t.after(() => gateway.close());
  const url = `http://127.0.0.1:${gateway.server.address().port}`;
  const call = (path, init = {}) => fetch(url + path, { ...init, headers: { Authorization: `Bearer ${KEY}`, ...init.headers } });
  const post = (path, body, init = {}) => call(path, { method: "POST", body: JSON.stringify(body), ...init, headers: { "Content-Type": "application/json", ...init.headers } });
  const responses = (body = responsesBody, init) => post("/v1/responses", body, init);
  const messages = (body = messagesBody, init) => post("/v1/messages", body, init);
  return { api, gateway, calls, url, call, post, responses, messages };
}
const historyOf = (payload) => JSON.parse(payload.messages[0].content_block[0].content.text_block.text);

test("Responses：文本、instructions、output 消息与 JSON 格式", async (t) => {
  const f = await fixture(t);
  const response = await f.responses({ ...responsesBody, instructions: "仅用中文", metadata: { task: "测试" } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /application\/json/);
  const value = await response.json();
  assert.equal(value.object, "response");
  assert.equal(value.status, "completed");
  assert.match(value.id, /^resp_/);
  assert.equal(value.output[0].type, "message");
  assert.equal(value.output[0].role, "assistant");
  assert.equal(value.output[0].status, "completed");
  assert.equal(value.output[0].content[0].text, "你好，世界");
  assert.equal(value.usage, null);
  assert.deepEqual(value.metadata, { task: "测试" });
  assert.deepEqual(historyOf(f.calls[0]), [{ role: "developer", content: "仅用中文" }, { role: "user", content: "你好" }]);
  assert(!JSON.stringify(f.calls[0]).includes(KEY));
});

test("Responses：SSE 生命周期、递增序号、逐段中文以及单个 completed", async (t) => {
  let source;
  const f = await fixture(t, { api: { post: async () => new Response(new ReadableStream({ start(c) { source = c; c.enqueue(new TextEncoder().encode(frame("CHUNK_DELTA", { text: "第一段" }))); } }), { headers: { "content-type": "text/event-stream" } }) } });
  const response = await f.responses({ ...responsesBody, stream: true });
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const reader = response.body.getReader();
  let text = "";
  while (!text.includes("response.output_text.delta")) text += new TextDecoder().decode((await reader.read()).value);
  assert(text.includes("第一段"));
  assert(!text.includes("response.completed"));
  source.enqueue(new TextEncoder().encode(frame("CHUNK_DELTA", { text: "，第二段" }) + frame("SSE_REPLY_END", {})));
  source.close();
  for (;;) { const part = await reader.read(); if (part.done) break; text += new TextDecoder().decode(part.value); }
  const list = events(text);
  assert.deepEqual(list.slice(0, 4).map((event) => event.event), ["response.created", "response.in_progress", "response.output_item.added", "response.content_part.added"]);
  assert.deepEqual(list.map(({ data }) => data.sequence_number), list.map((_, index) => index));
  assert.equal(list.filter(({ event }) => event === "response.completed").length, 1);
  const completed = list.at(-1).data.response;
  assert.equal(completed.output[0].content[0].text, "第一段，第二段");
  assert.equal(list.find(({ event }) => event === "response.output_text.done").data.item_id, completed.output[0].id);
  assert(!text.includes("[DONE]"));
  assert.equal((await (await f.call(`/v1/responses/${completed.id}`)).json()).id, completed.id);
});

test("Responses：续接携带历史，顶层 instructions 由新请求替换，缓存可读取和删除", async (t) => {
  const f = await fixture(t);
  const first = await (await f.responses({ ...responsesBody, instructions: "第一轮规则" })).json();
  const second = await (await f.responses({ ...responsesBody, input: [{ role: "user", content: [{ type: "input_text", text: "继续" }] }], instructions: "第二轮规则", previous_response_id: first.id })).json();
  assert.equal(second.previous_response_id, first.id);
  assert.deepEqual(historyOf(f.calls[1]), [{ role: "developer", content: "第二轮规则" }, { role: "user", content: "你好" }, { role: "assistant", content: "你好，世界" }, { role: "user", content: "继续" }]);
  assert.equal((await fetch(f.url + `/v1/responses/${first.id}`)).status, 401);
  const removed = await (await f.call(`/v1/responses/${first.id}`, { method: "DELETE" })).json();
  assert.deepEqual(removed, { id: first.id, object: "response", deleted: true });
  assert.equal((await f.responses({ ...responsesBody, previous_response_id: first.id })).status, 404);
});

test("Responses：store=false、缓存过期和条目淘汰均明确返回不存在", async (t) => {
  let clock = 1000;
  const f = await fixture(t, { responseCache: { maxEntries: 1, ttlMs: 1000, now: () => clock } });
  const notStored = await (await f.responses({ ...responsesBody, store: false })).json();
  assert.equal(notStored.store, false);
  assert.equal((await f.call(`/v1/responses/${notStored.id}`)).status, 404);
  const first = await (await f.responses()).json();
  const second = await (await f.responses()).json();
  assert.equal((await f.call(`/v1/responses/${first.id}`)).status, 404);
  assert.equal((await f.call(`/v1/responses/${second.id}`)).status, 200);
  clock += 1001;
  assert.equal((await f.call(`/v1/responses/${second.id}`)).status, 404);
  const small = await fixture(t, { responseCache: { maxBytes: 100 } });
  const tooLarge = await (await small.responses()).json();
  assert.equal(tooLarge.store, false);
});

test("Responses：切换默认账号后拒绝自动复用另一账号的上下文", async (t) => {
  let uid = "first:0";
  const f = await fixture(t, { store: { account: async () => ({ uid, secret: {} }) } });
  const first = await (await f.responses()).json();
  uid = "second:0";
  const denied = await f.responses({ ...responsesBody, previous_response_id: first.id });
  assert.equal(denied.status, 409);
  assert.equal(f.calls.length, 1);
});

test("Responses：函数工具 JSON/SSE 及 function_call_output 往返", async (t) => {
  let count = 0;
  const requests = [];
  const f = await fixture(t, { api: { post: async (_secret, _path, payload) => {
    requests.push(payload);
    const prompt = payload.messages[0].content_block[0].content.text_block.text;
    if (++count > 2) return upstream("查询完成");
    const marker = prompt.match(/magpie_doubaowork_tools_[a-f0-9]+/)[0];
    return upstream(JSON.stringify({ [marker]: [{ name: "lookup", arguments: { city: "上海" } }, { name: "lookup", arguments: { city: "北京" } }] }));
  } } });
  const body = { ...responsesBody, tools: [{ type: "function", name: "lookup", description: "查询城市", parameters: { type: "object", properties: { city: { type: "string" } } } }], tool_choice: { type: "function", name: "lookup" } };
  const first = await (await f.responses(body)).json();
  assert.equal(first.output.length, 2);
  assert(first.output.every((item) => item.type === "function_call" && item.status === "completed"));
  assert.equal(JSON.parse(first.output[0].arguments).city, "上海");
  const list = events(await (await f.responses({ ...body, stream: true })).text());
  assert.equal(list.filter(({ event }) => event === "response.function_call_arguments.delta").length, 2);
  assert.equal(list.filter(({ event }) => event === "response.function_call_arguments.done").length, 2);
  assert.equal(list.at(-1).event, "response.completed");
  const outputs = first.output.map((item) => ({ type: "function_call_output", call_id: item.call_id, output: "已找到" }));
  const next = await (await f.responses({ ...responsesBody, input: outputs, previous_response_id: first.id })).json();
  assert.equal(next.output[0].content[0].text, "查询完成");
  const history = historyOf(requests[2]);
  assert.equal(history[1].tool_calls.length, 2);
  assert.deepEqual(history.slice(-2).map((message) => message.tool_call_id), first.output.map((item) => item.call_id));
});

test("Responses：可重放 assistant、function_call 和文本工具结果", async (t) => {
  const f = await fixture(t);
  const response = await f.responses({ ...responsesBody, input: [
    { role: "user", content: "查询" }, { type: "message", role: "assistant", content: [{ type: "output_text", text: "开始查询" }] },
    { type: "function_call", call_id: "call-history", name: "lookup", arguments: '{"city":"上海"}' },
    { type: "function_call_output", call_id: "call-history", output: [{ type: "input_text", text: "晴天" }] },
  ] });
  assert.equal(response.status, 200);
  const history = historyOf(f.calls[0]);
  assert.equal(history.at(-1).role, "tool");
  assert.equal(history.at(-1).content, "晴天");
});

test("Responses：上游思考仅映射为真实摘要，不生成加密推理状态", async (t) => {
  const thinking = frame("STREAM_MSG_NOTIFY", { content: { content_block: [{ block_id: "thinking", block_type: 10000, content: { text_block: { text: "逐步分析", icon_url: "deep_think" } } }] } });
  const f = await fixture(t, { api: { post: async () => new Response(thinking + frame("CHUNK_DELTA", { text: "答案" }) + frame("SSE_REPLY_END", {}), { headers: { "content-type": "text/event-stream" } }) } });
  const first = await (await f.responses({ ...responsesBody, reasoning: { summary: "auto", effort: "high" } })).json();
  assert.equal(first.output[0].type, "reasoning");
  assert.equal(first.output[0].summary[0].text, "逐步分析");
  assert.equal(first.output[0].encrypted_content, undefined);
  const list = events(await (await f.responses({ ...responsesBody, stream: true, reasoning: { summary: "auto" } })).text());
  assert.equal(list.find(({ event }) => event === "response.reasoning_summary_text.delta").data.delta, "逐步分析");
  assert.equal(list.at(-1).data.response.output[1].content[0].text, "答案");
});

test("Claude：原生 JSON、system 内容块、X-API-Key 与明确标记的估算 usage", async (t) => {
  const f = await fixture(t);
  const response = await f.messages({ ...messagesBody, system: [{ type: "text", text: "仅用中文", cache_control: { type: "ephemeral" } }] }, { headers: { Authorization: "", "X-API-Key": KEY, "Anthropic-Version": "2023-06-01" } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-doubao-usage"), "estimated");
  const value = await response.json();
  assert.equal(value.type, "message");
  assert.equal(value.role, "assistant");
  assert.match(value.id, /^msg_/);
  assert.deepEqual(value.content, [{ type: "text", text: "你好，世界" }]);
  assert.equal(value.stop_reason, "end_turn");
  assert.equal(value.stop_sequence, null);
  assert(Number.isSafeInteger(value.usage.input_tokens) && value.usage.input_tokens > 0);
  assert(Number.isSafeInteger(value.usage.output_tokens) && value.usage.output_tokens > 0);
  assert.equal(value.usage.cache_read_input_tokens, 0);
  assert.equal(historyOf(f.calls[0])[0].role, "system");
});

test("Claude：SSE content_block 生命周期和 message_stop", async (t) => {
  const f = await fixture(t);
  const response = await f.messages({ ...messagesBody, stream: true });
  const list = events(await response.text());
  assert.deepEqual(list.map(({ event }) => event), ["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
  assert.equal(list[0].data.message.content.length, 0);
  assert.equal(list[0].data.message.usage.output_tokens, 0);
  assert.equal(list[2].data.delta.type, "text_delta");
  assert.equal(list[2].data.delta.text, "你好，世界");
  assert.equal(list[4].data.delta.stop_reason, "end_turn");
  assert(list[4].data.usage.output_tokens > 0);
});

test("Claude：tool_use、input_json_delta、tool_result 与用户后续文本", async (t) => {
  let count = 0;
  const requests = [];
  const f = await fixture(t, { api: { post: async (_secret, _path, payload) => {
    requests.push(payload);
    if (++count > 2) return upstream("工具结果已收到");
    const marker = payload.messages[0].content_block[0].content.text_block.text.match(/magpie_doubaowork_tools_[a-f0-9]+/)[0];
    return upstream(JSON.stringify({ [marker]: [{ name: "lookup", arguments: { value: "中文" } }] }));
  } } });
  const body = { ...messagesBody, tools: [{ name: "lookup", input_schema: { type: "object", properties: { value: { type: "string" } } } }], tool_choice: { type: "any", disable_parallel_tool_use: true } };
  const first = await (await f.messages(body)).json();
  assert.equal(first.stop_reason, "tool_use");
  assert.equal(first.content[0].type, "tool_use");
  assert.deepEqual(first.content[0].input, { value: "中文" });
  const list = events(await (await f.messages({ ...body, stream: true })).text());
  assert.equal(list[1].data.content_block.type, "tool_use");
  assert.deepEqual(list[1].data.content_block.input, {});
  assert.deepEqual(JSON.parse(list[2].data.delta.partial_json), { value: "中文" });
  assert.equal(list[4].data.delta.stop_reason, "tool_use");
  const continued = await f.messages({ ...messagesBody, messages: [
    messagesBody.messages[0], { role: "assistant", content: first.content },
    { role: "user", content: [{ type: "tool_result", tool_use_id: first.content[0].id, content: [{ type: "text", text: "查询成功" }] }, { type: "text", text: "请总结" }] },
  ] });
  assert.equal((await continued.json()).content[0].text, "工具结果已收到");
  assert.deepEqual(historyOf(requests[2]).slice(-2).map((message) => [message.role, message.content]), [["tool", "查询成功"], ["user", "请总结"]]);
});

test("Claude：count_tokens 无需 max_tokens，只估算输入、不发起模型生成", async (t) => {
  const f = await fixture(t);
  const body = { model: "flash", messages: messagesBody.messages, system: "系统指令" };
  const response = await f.post("/v1/messages/count_tokens", body);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-doubao-usage"), "estimated");
  assert((await response.json()).input_tokens > 0);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.post("/v1/messages/count_tokens", { ...body, model: "missing" })).status, 404);
});

test("两种协议：鉴权、模型、方法与不支持的输入返回各自错误格式", async (t) => {
  const f = await fixture(t);
  const denied = await fetch(f.url + "/v1/messages", { method: "POST" });
  assert.equal(denied.status, 401);
  const error = await denied.json();
  assert.equal(error.type, "error");
  assert.equal(error.error.type, "authentication_error");
  assert.equal(error.request_id, denied.headers.get("request-id"));
  assert(!JSON.stringify(error).includes(KEY));
  assert.equal((await f.call("/v1/messages")).status, 405);
  for (const value of [{ ...responsesBody, input: [] }, { ...responsesBody, stream: "true" }, { ...responsesBody, background: true }, { ...responsesBody, input: [{ role: "user", content: [{ type: "input_image", image_url: "https://example.test/image" }] }] }, { ...responsesBody, input: [{ type: "function_call_output", call_id: "unknown", output: "错误" }] }, { ...responsesBody, text: { format: { type: "json_schema" } } }, { ...responsesBody, tools: [{ type: "web_search" }] }]) {
    assert.equal((await f.responses(value)).status, 400);
  }
  for (const value of [{ ...messagesBody, max_tokens: 0 }, { ...messagesBody, messages: [] }, { ...messagesBody, messages: [{ role: "user", content: [{ type: "image", source: {} }] }] }, { ...messagesBody, tools: [{ type: "computer_20250124", name: "computer" }] }, { ...messagesBody, stop_sequences: ["STOP"] }]) assert.equal((await f.messages(value)).status, 400);
  const missing = await f.messages({ ...messagesBody, model: "missing" });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.type, "not_found_error");
  assert.equal(f.calls.length, 0);
});

test("原生协议：预检允许 SDK 请求头和 Responses 删除，来源仍受限制", async (t) => {
  const f = await fixture(t, { corsOrigins: ["https://client.example.test"] });
  const response = await fetch(f.url + "/v1/messages", { method: "OPTIONS", headers: { Origin: "https://client.example.test", "Access-Control-Request-Headers": "x-api-key,anthropic-version" } });
  assert.equal(response.status, 204);
  assert.match(response.headers.get("access-control-allow-headers"), /Anthropic-Version/);
  const blocked = await f.messages(messagesBody, { headers: { Origin: "https://evil.example.test" } });
  assert.equal(blocked.status, 403);
  assert.equal((await blocked.json()).error.type, "permission_error");
  assert.equal(f.calls.length, 0);
  const preflight = await fetch(f.url + "/v1/responses/resp_test", { method: "OPTIONS", headers: { Origin: "https://client.example.test", "Access-Control-Request-Method": "DELETE", "Access-Control-Request-Headers": "authorization" } });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get("access-control-allow-methods"), /\bDELETE\b/);
  const created = await f.responses(responsesBody, { headers: { Origin: "https://client.example.test" } });
  assert.equal(created.status, 200);
  assert.match(created.headers.get("access-control-expose-headers"), /X-Request-ID/);
  assert.match(created.headers.get("access-control-expose-headers"), /X-Doubao-Usage/);
  const { id } = await created.json();
  const deleted = await f.call("/v1/responses/" + id, { method: "DELETE", headers: { Origin: "https://client.example.test" } });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.headers.get("access-control-allow-origin"), "https://client.example.test");
  assert.equal((await f.call("/v1/responses/" + id)).status, 404);
  assert.equal(f.calls.length, 1);
});

test("两种协议：截断上游报告 error，不发送成功终止事件", async (t) => {
  for (const protocol of ["responses", "messages"]) {
    await t.test(protocol, async (t) => {
      const f = await fixture(t, { api: { post: async () => upstream("部分回答", false) } });
      const response = await f[protocol]({ ...(protocol === "responses" ? responsesBody : messagesBody), stream: true });
      const text = await response.text();
      const list = events(text);
      assert.equal(list.at(-1).event, "error");
      assert(!text.includes("response.completed") && !text.includes("message_stop") && !text.includes("[DONE]"));
      assert(!text.includes("PRIVATE_PROTOCOL_FIXTURE"));
      assert.equal((await f[protocol]({ ...(protocol === "responses" ? responsesBody : messagesBody), stream: false })).status, 502);
    });
  }
});

test("两种协议：心跳后的超时使用原生错误事件，且不重复上游请求", async (t) => {
  for (const protocol of ["responses", "messages"]) {
    await t.test(protocol, async (t) => {
      let count = 0;
      const f = await fixture(t, { timeoutMs: 90, heartbeatMs: 10, api: { post: async (_secret, _path, _body, { signal }) => {
        count++;
        return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      } } });
      const response = await f[protocol]({ ...(protocol === "responses" ? responsesBody : messagesBody), stream: true });
      const text = await response.text();
      assert.match(text, /: keep-alive/);
      const last = events(text).at(-1).data;
      assert.equal(protocol === "responses" ? last.code : last.error.type, protocol === "responses" ? "request_timeout" : "api_error");
      assert(!text.includes("response.completed") && !text.includes("message_stop"));
      assert.equal(count, 1);
    });
  }
});

test("两种协议：共享账号并发容量，断开原生流后取消上游并释放容量", async (t) => {
  let number = 0, cancelled;
  const observed = new Promise((resolve) => { cancelled = resolve; });
  const f = await fixture(t, { maxConcurrency: 1, api: { post: async (_secret, _path, _body, { signal }) => {
    if (++number > 1) return upstream("下一条回答");
    signal.addEventListener("abort", cancelled, { once: true });
    return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(frame("CHUNK_DELTA", { text: "首段" }))); }, cancel() { cancelled(); } }), { headers: { "content-type": "text/event-stream" } });
  } } });
  const controller = new AbortController();
  const first = await f.responses({ ...responsesBody, stream: true }, { signal: controller.signal });
  await first.body.getReader().read();
  const busy = await f.messages();
  assert.equal(busy.status, 429);
  assert.equal((await busy.json()).error.type, "rate_limit_error");
  controller.abort();
  await Promise.race([observed, delay(2000).then(() => { throw Error("上游未取消"); })]);
  let retry;
  for (let i = 0; i < 20; i++) { retry = await f.messages(); if (retry.status !== 429) break; await delay(10); }
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).content[0].text, "下一条回答");
});

test("三种协议：默认每账号共享 3 个并发，第 4 个请求限流，断开后恢复容量", async (t) => {
  let number = 0, cancelled;
  const observed = new Promise((resolve) => { cancelled = resolve; });
  const f = await fixture(t, { api: { post: async (_secret, _path, _body, { signal }) => {
    if (++number > 3) return upstream("释放后的回答");
    signal.addEventListener("abort", cancelled, { once: true });
    return new Response(new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode(frame("CHUNK_DELTA", { text: "进行中的回答" }))); },
      cancel() { cancelled(); },
    }), { headers: { "content-type": "text/event-stream" } });
  } } });
  const requests = [
    ["/v1/chat/completions", messagesBody],
    ["/v1/responses", responsesBody],
    ["/v1/messages", messagesBody],
  ];
  const controllers = requests.map(() => new AbortController());
  t.after(() => controllers.forEach((controller) => controller.abort()));
  const streams = await Promise.all(requests.map(([path, value], i) =>
    f.post(path, { ...value, stream: true }, { signal: controllers[i].signal })));
  for (const response of streams) {
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    assert.equal((await response.body.getReader().read()).done, false);
  }
  for (const [path, value] of requests) {
    const busy = await f.post(path, value);
    assert.equal(busy.status, 429);
    assert.equal(busy.headers.get("retry-after"), "1");
    assert.equal((await busy.json()).error.type, "rate_limit_error");
  }
  assert.equal(number, 3);
  controllers[0].abort();
  await Promise.race([observed, delay(2000).then(() => { throw Error("上游未取消"); })]);
  let retry;
  for (let i = 0; i < 20; i++) {
    retry = await f.responses();
    if (retry.status !== 429) break;
    await retry.json();
    await delay(10);
  }
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).output[0].content[0].text, "释放后的回答");
  assert.equal(number, 4);
});
