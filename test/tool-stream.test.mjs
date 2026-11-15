// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { createCompletion } from "../completion.mjs";

const model = { id: "flash", name: "Flash", agentMode: 2, modeId: "3", deepThink: 4, extra: {} };
const body = {
  model: "flash", stream: true,
  messages: [{ role: "user", content: "你好" }],
  tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
};
const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const text = (value) => frame("CHUNK_DELTA", { text: value });
const thinking = frame("STREAM_MSG_NOTIFY", { content: { content_block: [{
  block_id: "thinking", block_type: 10000,
  content: { text_block: { text: "正在分析", icon_url: "deep_think" } },
}] } });
const encoder = new TextEncoder();

function fixture(t, initial, request = body) {
  const controller = new AbortController();
  let source, marker, cancelled = false;
  t.after(() => controller.abort());
  const api = {
    catalog: async () => ({ bot: "BOT", models: { flash: model } }),
    post: async (_secret, _path, payload) => {
      marker = payload.messages[0].content_block[0].content.text_block.text.match(/magpie_doubaowork_tools_[a-f0-9]+/)[0];
      return new Response(new ReadableStream({
        start(c) { source = c; c.enqueue(encoder.encode(initial)); },
        cancel() { cancelled = true; },
      }), { headers: { "content-type": "text/event-stream" } });
    },
  };
  let response, failure;
  const completion = createCompletion(api, {}, request, { signal: controller.signal });
  completion.then((value) => { response = value; }, (error) => { failure = error; });
  return {
    async responseBeforeEnd() {
      await tick();
      if (failure) throw failure;
      assert(response, "上游仍在生成时，首段正文或思考就应当交给客户端");
      return response;
    },
    send(value) { source.enqueue(encoder.encode(value)); },
    finish(value = "") { source.enqueue(encoder.encode(value + frame("SSE_REPLY_END", {}))); source.close(); },
    get marker() { return marker; },
    get cancelled() { return cancelled; },
  };
}
function events(value) {
  return value.split(/\r?\n\r?\n/).filter(Boolean).map((part) => {
    const data = part.replace(/^data: /, "");
    return data === "[DONE]" ? data : JSON.parse(data);
  });
}
async function rest(reader) {
  let value = "";
  for (;;) {
    const part = await reader.read();
    if (part.done) return value;
    value += new TextDecoder().decode(part.value);
  }
}

test("工具桥：可选工具的普通回答在上游结束前逐段流出", async (t) => {
  const f = fixture(t, text("  你好"));
  const response = await f.responseBeforeEnd();
  const reader = response.body.getReader();
  const initial = new TextDecoder().decode((await reader.read()).value);
  assert.deepEqual(events(initial)[0].choices[0].delta, { content: "  你好", role: "assistant" });
  assert(!initial.includes("[DONE]"));
  f.finish(text("，世界"));
  const all = events(initial + await rest(reader));
  assert.equal(all.filter((event) => event !== "[DONE]").map((event) => event.choices[0].delta.content || "").join(""), "  你好，世界");
  assert.equal(all.at(-2).choices[0].finish_reason, "stop");
  assert.equal(all.at(-1), "[DONE]");
});

test("工具桥：思考即时流出，工具 JSON 直到结束和校验后才发送", async (t) => {
  const f = fixture(t, thinking, { ...body, tool_choice: "required" });
  const reader = (await f.responseBeforeEnd()).body.getReader();
  const initial = new TextDecoder().decode((await reader.read()).value);
  assert.deepEqual(events(initial)[0].choices[0].delta, { reasoning_content: "正在分析", role: "assistant" });
  let delivered = false;
  const pending = reader.read().then((part) => { delivered = true; return part; });
  const answer = JSON.stringify({ [f.marker]: [{ name: "lookup", arguments: { city: "上海" } }] });
  f.send(text(answer.slice(0, 20)));
  await tick();
  assert.equal(delivered, false);
  f.finish(text(answer.slice(20)));
  const all = initial + new TextDecoder().decode((await pending).value) + await rest(reader);
  const list = events(all);
  const tool = list.find((event) => event !== "[DONE]" && event.choices[0].delta.tool_calls)?.choices[0].delta.tool_calls[0];
  assert.equal(tool.function.name, "lookup");
  assert.deepEqual(JSON.parse(tool.function.arguments), { city: "上海" });
  assert.equal(tool.index, 0);
  assert(!all.includes(f.marker));
  assert.equal(list.at(-2).choices[0].finish_reason, "tool_calls");
});

test("工具桥：跨块的代码围栏和前导空白不会泄露未校验的工具 JSON", async (t) => {
  const f = fixture(t, thinking);
  const reader = (await f.responseBeforeEnd()).body.getReader();
  await reader.read();
  let delivered = false;
  const pending = reader.read().then((part) => { delivered = true; return part; });
  for (const fragment of [" \n`", "``json\n", JSON.stringify({ [f.marker]: [{ name: "lookup", arguments: {} }] }) + "\n```" ]) {
    f.send(text(fragment));
    await tick();
    assert.equal(delivered, false);
  }
  f.finish();
  const all = new TextDecoder().decode((await pending).value) + await rest(reader);
  assert(!all.includes(f.marker));
  assert.equal(events(all)[0].choices[0].delta.tool_calls[0].function.name, "lookup");
});

test("工具桥：思考后返回未声明工具时中止，不发送成功终止标记", async (t) => {
  const f = fixture(t, thinking, { ...body, tool_choice: "required" });
  const reader = (await f.responseBeforeEnd()).body.getReader();
  const initial = new TextDecoder().decode((await reader.read()).value);
  f.finish(text(JSON.stringify({ [f.marker]: [{ name: "not_declared", arguments: {} }] })));
  await assert.rejects(reader.read(), (error) => error.status === 502);
  assert(!initial.includes("tool_calls"));
  assert(!initial.includes("[DONE]"));
});

test("工具桥：客户端在等待工具参数时取消，立即取消上游读取", async (t) => {
  const f = fixture(t, thinking, { ...body, tool_choice: "required" });
  const reader = (await f.responseBeforeEnd()).body.getReader();
  await reader.read();
  f.send(text('{"'));
  await tick();
  await reader.cancel();
  assert.equal(f.cancelled, true);
});
