import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeEvents } from "../stream.mjs";
const event = (name, v) =>
  "event: " + name + "\ndata: " + JSON.stringify(v) + "\n\n";
const block = (text) => ({
  block_id: "b",
  block_type: 10000,
  content: { text_block: { text } },
});
function response(text) {
  const bytes = new TextEncoder().encode(text);
  let i = 0;
  return new Response(
    new ReadableStream({
      pull(c) {
        if (i === bytes.length) c.close();
        else c.enqueue(bytes.slice(i, (i += Math.min(3, bytes.length - i))));
      },
    }),
  );
}
test("分片中文 SSE、增量与快照去重，结束标记必须真实存在", async () => {
  const raw =
    event("STREAM_MSG_NOTIFY", {
      content: { content_block: [block("你好")] },
    }) +
    event("FULL_MSG_NOTIFY", {
      message: { user_type: 2, content_block: [block("你好世界")] },
    }) +
    event("SSE_REPLY_END", {});
  const values = [];
  for await (const d of decodeEvents(response(raw))) values.push(d);
  assert.deepEqual(values, [{ content: "你好" }, { content: "世界" }]);
  await assert.rejects(async () => {
    for await (const _ of decodeEvents(
      response(event("CHUNK_DELTA", { text: "partial" })),
    )) {
    }
  }, /结束/);
});
test("首帧人机验证归类 429，不把业务错误当成功正文", async () => {
  await assert.rejects(
    async () => {
      for await (const _ of decodeEvents(
        response(
          event("STREAM_ERROR", {
            error_code: 710022004,
            error_msg: "SENSITIVE_PAYLOAD",
          }),
        ),
      )) {
      }
    },
    (e) => e.status === 429 && !e.message.includes("SENSITIVE_PAYLOAD"),
  );
});
test("思考与正文分开；修订已输出文本时停止，不拼接伪造结果", async () => {
  const thinking = {
    ...block("思考"),
    block_id: "r",
    content: { text_block: { text: "思考", icon_url: "deep_think" } },
  };
  const raw =
    event("STREAM_MSG_NOTIFY", {
      content: { content_block: [thinking, block("答复")] },
    }) +
    event("FULL_MSG_NOTIFY", {
      message: { user_type: 2, content_block: [block("另一份")] },
    });
  const got = [];
  await assert.rejects(async () => {
    for await (const d of decodeEvents(response(raw))) got.push(d);
  }, /修订/);
  assert.deepEqual(got, [{ reasoning_content: "思考" }, { content: "答复" }]);
});

const patch = (rows, object = 1) => event("STREAM_CHUNK", {
  message_id: "assistant",
  patch_op: [{ patch_object: object, patch_type: 1, patch_value: { content_block: rows } }],
});
test("紧凑增量延续当前文本块，完整快照不重复已输出正文", async () => {
  const raw = patch([block("你好")])
    + patch([], 111)
    + event("CHUNK_DELTA", { text: "世界" })
    + event("FULL_MSG_NOTIFY", { message: { user_type: 2, content_block: [block("你好世界")] } })
    + event("SSE_REPLY_END", {});
  const values = [];
  for await (const delta of decodeEvents(response(raw))) values.push(delta);
  assert.deepEqual(values, [{ content: "你好" }, { content: "世界" }]);
});
test("紧凑增量继承思考元数据，切换正文块后分别去重", async () => {
  const reasoningHeader = {
    ...block(""), block_id: "reasoning",
    content: { text_block: { icon_url: "deep_think" } },
  };
  const raw = patch([reasoningHeader])
    + event("CHUNK_DELTA", { text: "推理" })
    + patch([block("答")])
    + event("CHUNK_DELTA", { text: "复" })
    + event("FULL_MSG_NOTIFY", { message: { user_type: 2, content_block: [
      { ...reasoningHeader, content: { text_block: { text: "推理", icon_url: "deep_think" } } },
      block("答复"),
    ] } })
    + event("SSE_REPLY_END", {});
  const values = [];
  for await (const delta of decodeEvents(response(raw))) values.push(delta);
  assert.deepEqual(values, [{ reasoning_content: "推理" }, { content: "答" }, { content: "复" }]);
});
test("任务状态块的紧凑增量不冒充回答正文", async () => {
  const raw = patch([{ block_id: "status", block_type: 10040, content: { thinking_block: {} } }])
    + event("CHUNK_DELTA", { text: "任务状态" })
    + patch([block("真正答复")])
    + event("SSE_REPLY_END", {});
  const values = [];
  for await (const delta of decodeEvents(response(raw))) values.push(delta);
  assert.deepEqual(values, [{ content: "真正答复" }]);
});
