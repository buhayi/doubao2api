// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { createGateway } from "../gateway/server.mjs";
import { createHistoryCleaner } from "../gateway/history.mjs";
import { fail } from "../protocol.mjs";

const key = "HISTORY_FIXTURE_KEY";
const secret = { cookieHeader: "sessionid=PRIVATE_HISTORY_COOKIE", userId: "fixture-account" };
const model = { id: "flash", name: "测试模型", agentMode: 2, modeId: "3", deepThink: 4, extra: {} };
const chatBody = { model: "flash", messages: [{ role: "user", content: "客户端保存的上下文" }] };
const requests = [
  ["chat", "/v1/chat/completions", chatBody],
  ["responses", "/v1/responses", { model: "flash", input: "客户端保存的上下文" }],
  ["claude", "/v1/messages", { ...chatBody, max_tokens: 1024 }],
];
const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const acknowledged = (payload, id) => frame("SSE_ACK", { ack_client_meta: { ...payload.client_meta, conversation_id: id } });
const native = (payload, id) => new Response(acknowledged(payload, id) + frame("CHUNK_DELTA", { text: "客户端回答" }) + frame("SSE_REPLY_END", {}), { headers: { "content-type": "text/event-stream" } });
const context = { conversationId: "new-proxy-conversation", botId: "BOT", localConversationId: "local_fixture" };
async function fixture(t, options = {}) {
  const generated = [], archived = [], logs = [];
  const api = {
    catalog: async () => ({ bot: "BOT", models: { flash: model } }),
    post: async (account, path, payload, init) => {
      if (path === "/alice/conversation/archive") {
        archived.push({ account, payload, signal: init.signal });
        return options.archive ? options.archive(payload, init) : { code: 0 };
      }
      assert.equal(path, "/chat/completion");
      generated.push(payload);
      const id = "proxy-" + generated.length;
      return options.native ? options.native(payload, id, init) : native(payload, id);
    },
  };
  const gateway = createGateway({
    store: { account: async () => ({ uid: "fixture:0", secret }) }, apiKey: key, api,
    heartbeatMs: 0, ...(options.hideHistory === undefined ? {} : { hideHistory: options.hideHistory }),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    historyCleanup: { timeoutMs: 1000, logger: (message) => logs.push(message) },
  });
  t.after(() => gateway.close());
  gateway.server.listen(0, "127.0.0.1");
  await once(gateway.server, "listening");
  const url = `http://127.0.0.1:${gateway.server.address().port}`;
  const call = (path, init = {}) => fetch(url + path, { ...init, headers: { Authorization: `Bearer ${key}`, ...init.headers } });
  const post = (path, value, init = {}) => call(path, { method: "POST", body: JSON.stringify(value), ...init, headers: { "Content-Type": "application/json", ...init.headers } });
  return { gateway, generated, archived, logs, call, post };
}
async function settled(check) {
  for (let i = 0; i < 50; i++) { if (check()) return; await delay(10); }
  assert(check(), "会话清理未结束");
}

test("历史隐藏：三种协议默认启用，JSON/SSE 只归档本次上游会话并保留回答", async (t) => {
  for (const [protocol, path, value] of requests) {
    for (const stream of [false, true]) await t.test(`${protocol} ${stream ? "SSE" : "JSON"}`, async (t) => {
      const f = await fixture(t);
      const response = await f.post(path, { ...value, stream });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-doubao-history"), stream ? "auto-cleanup" : "hidden");
      const text = await response.text();
      assert(text.includes("客户端回答"));
      assert(!text.includes("proxy-1") && !text.includes(secret.cookieHeader));
      assert.equal(f.generated.length, 1);
      assert.equal(f.generated[0].client_meta.conversation_id, "");
      assert.equal(f.archived.length, 1);
      assert.equal(f.archived[0].account, secret);
      assert.deepEqual(f.archived[0].payload, { conversation_id: "proxy-1", bot_id: "BOT", local_conversation_id: f.generated[0].client_meta.local_conversation_id });
      assert.equal(f.gateway.historyStatus().hidden, 1);
      assert.equal(f.gateway.historyStatus().failed, 0);
    });
  }
});

test("历史隐藏：关闭时不归档，原始客户端历史继续发送", async (t) => {
  const f = await fixture(t, { hideHistory: false });
  const response = await f.post(requests[0][1], chatBody);
  assert.equal(response.headers.get("x-doubao-history"), "retained");
  assert.equal((await response.json()).choices[0].message.content, "客户端回答");
  assert.equal(f.archived.length, 0);
  assert.equal(f.gateway.historyStatus().enabled, false);
  assert.equal(JSON.parse(f.generated[0].messages[0].content_block[0].content.text_block.text)[0].content, chatBody.messages[0].content);
});

test("历史隐藏：没有 ACK 时使用本次 FULL_MSG_NOTIFY 的会话编号", async (t) => {
  const f = await fixture(t, { native: (_payload, id) => new Response(frame("FULL_MSG_NOTIFY", { message: { user_type: 1, conversation_id: id } }) + frame("CHUNK_DELTA", { text: "客户端回答" }) + frame("SSE_REPLY_END", {})) });
  assert.equal((await f.post(requests[0][1], chatBody)).status, 200);
  assert.equal(f.archived[0].payload.conversation_id, "proxy-1");
});

test("历史隐藏：忽略其他本地会话、其他 bot 和不安全编号，缺少编号时不归档", async (t) => {
  const f = await fixture(t, { native: (payload) => new Response(
    frame("SSE_ACK", { ack_client_meta: { ...payload.client_meta, local_conversation_id: "local_other", conversation_id: "existing-other" } })
    + frame("SSE_ACK", { ack_client_meta: { ...payload.client_meta, bot_id: "OTHER_BOT", conversation_id: "existing-other" } })
    + frame("SSE_ACK", { ack_client_meta: { ...payload.client_meta, conversation_id: 9007199254740992 } })
    + frame("CHUNK_DELTA", { text: "客户端回答" }) + frame("SSE_REPLY_END", {})) });
  const response = await f.post(requests[0][1], chatBody);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-doubao-history"), "failed");
  assert.equal(f.archived.length, 0);
  assert.equal(f.gateway.historyStatus().lastFailure.reason, "missing_conversation_id");
  assert(!JSON.stringify(f.gateway.historyStatus()).includes(secret.cookieHeader));
});

test("历史隐藏：失败保留回答、不重新生成，日志和状态不包含上游异常凭据", async (t) => {
  const f = await fixture(t, { archive: () => { throw Object.assign(fail(401, "sessionid=PRIVATE_EXCEPTION_COOKIE"), { reason: "session_expired" }); } });
  const response = await f.post(requests[1][1], requests[1][2]);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-doubao-history"), "failed");
  assert.equal((await response.json()).output[0].content[0].text, "客户端回答");
  assert.equal(f.generated.length, 1);
  assert.equal(f.archived.length, 1);
  assert.equal(f.gateway.historyStatus().failed, 1);
  assert(!JSON.stringify([f.logs, f.gateway.historyStatus()]).includes("PRIVATE_EXCEPTION_COOKIE"));
});

test("历史隐藏：客户端断开、请求超时和服务关停后使用独立信号清理已确认的会话", async (t) => {
  for (const action of ["disconnect", "timeout", "shutdown"]) await t.test(action, async (t) => {
    let cleared;
    const observed = new Promise((resolve) => { cleared = resolve; });
    const f = await fixture(t, { timeoutMs: action === "timeout" ? 80 : 3000,
      native: (payload, id) => new Response(new ReadableStream({ start(c) {
        c.enqueue(new TextEncoder().encode(acknowledged(payload, id) + frame("CHUNK_DELTA", { text: "部分回答" })));
      } }), { headers: { "content-type": "text/event-stream" } }),
      archive: (_payload, { signal }) => { assert.equal(signal.aborted, false); cleared(); return { code: 0 }; },
    });
    const controller = new AbortController();
    t.after(() => controller.abort());
    const response = await f.post(requests[0][1], { ...chatBody, stream: true }, { signal: controller.signal });
    const reader = response.body.getReader();
    assert.equal((await reader.read()).done, false);
    if (action === "disconnect") controller.abort();
    if (action === "shutdown") await f.gateway.close();
    if (action === "timeout") await assert.rejects(async () => { while (!(await reader.read()).done) {} });
    await Promise.race([observed, delay(1000).then(() => { throw Error("已确认会话没有清理"); })]);
    await settled(() => f.gateway.historyStatus().hidden === 1);
    assert.equal(f.archived.length, 1);
    assert.equal(f.generated.length, 1);
  });
});

test("历史隐藏：上游中途出错仍清理，截断回答不输出 DONE", async (t) => {
  const f = await fixture(t, { native: (payload, id) => new Response(acknowledged(payload, id) + frame("CHUNK_DELTA", { text: "partial" })) });
  const response = await f.post(requests[0][1], { ...chatBody, stream: true });
  await assert.rejects(response.text());
  await settled(() => f.gateway.historyStatus().hidden === 1);
  assert.equal(f.archived.length, 1);
});

test("历史隐藏：工具桥验证失败也清理已完成的上游会话", async (t) => {
  const f = await fixture(t);
  const response = await f.post(requests[0][1], { ...chatBody, tools: [{ type: "function", function: { name: "client_tool", parameters: { type: "object" } } }], tool_choice: "required" });
  assert.equal(response.status, 502);
  assert.equal(f.archived.length, 1);
  assert.equal(f.gateway.historyStatus().hidden, 1);
});

test("历史隐藏：Responses 的本地读取和 previous_response_id 续接不受归档影响", async (t) => {
  const f = await fixture(t);
  const first = await (await f.post(requests[1][1], requests[1][2])).json();
  assert.equal((await f.call("/v1/responses/" + first.id)).status, 200);
  const second = await f.post(requests[1][1], { model: "flash", previous_response_id: first.id, input: "继续" });
  assert.equal(second.status, 200);
  assert.equal((await second.json()).output[0].content[0].text, "客户端回答");
  assert.equal(f.archived.length, 2);
  const history = JSON.parse(f.generated[1].messages[0].content_block[0].content.text_block.text);
  assert.deepEqual(history, [{ role: "user", content: "客户端保存的上下文" }, { role: "assistant", content: "客户端回答" }, { role: "user", content: "继续" }]);
});

test("历史隐藏：默认 3 个账号容量覆盖生成和清理，等待清理时第 4 个仍限流", async (t) => {
  const releases = [];
  let ready;
  const cleaning = new Promise((resolve) => { ready = resolve; });
  const f = await fixture(t, { archive: () => new Promise((resolve) => { releases.push(resolve); if (releases.length === 3) ready(); }) });
  t.after(() => releases.forEach((release) => release({ code: 0 })));
  const running = requests.map(([, path, value]) => f.post(path, value));
  await Promise.race([cleaning, delay(500).then(() => { throw Error("没有启动 3 个清理操作"); })]);
  const busy = await f.post(requests[0][1], chatBody);
  assert.equal(busy.status, 429);
  assert.equal(f.generated.length, 3);
  releases.forEach((release) => release({ code: 0 }));
  for (const response of await Promise.all(running)) { assert.equal(response.status, 200); await response.text(); }
  assert.equal(f.gateway.historyStatus().hidden, 3);
});

test("历史清理：超时有界，即使上游忽略取消也结束，异常响应不标记成功", async () => {
  let signal;
  const logs = [];
  const stalled = createHistoryCleaner({ timeoutMs: 20, logger: (message) => logs.push(message), api: { post: async (_secret, _path, _body, init) => { signal = init.signal; return new Promise(() => {}); } } });
  assert.equal(await stalled.clean(secret, context), "failed");
  assert.equal(signal.aborted, true);
  assert.equal(stalled.status().active, 0);
  assert.equal(stalled.status().lastFailure.reason, "cleanup_timeout");
  const malformed = createHistoryCleaner({ logger: (message) => logs.push(message), api: { post: async () => ({}) } });
  assert.equal(await malformed.clean(secret, context), "failed");
  assert.equal(malformed.status().hidden, 0);
  assert.equal(malformed.status().lastFailure.reason, "invalid_cleanup_response");
  assert(!JSON.stringify(logs).includes(secret.cookieHeader));
});
