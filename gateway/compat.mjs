// SPDX-License-Identifier: AGPL-3.0-only
import { fail } from "../protocol.mjs";

export const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
export function validateRequest(body) {
  if (!object(body)) throw fail(400, "请求正文必须是 JSON 对象。");
  if (typeof body.model !== "string" || !body.model.trim() || body.model.length > 256)
    throw fail(400, "请提供模型 ID，可从 /v1/models 获取。");
  if (body.stream != null && typeof body.stream !== "boolean") throw fail(400, "stream 必须是布尔值。");
  if (body.temperature != null && (typeof body.temperature !== "number" || !Number.isFinite(body.temperature) || body.temperature < 0 || body.temperature > 2)) throw fail(400, "temperature 必须是 0–2 之间的数值。");
  if (body.top_p != null && (typeof body.top_p !== "number" || !Number.isFinite(body.top_p) || body.top_p < 0 || body.top_p > 1)) throw fail(400, "top_p 必须是 0–1 之间的数值。");
}
export function protocolOptions(baseUrl) {
  return [
    { id: "chat", name: "OpenAI · Chat Completions", baseUrl, path: "/v1/chat/completions" },
    { id: "responses", name: "OpenAI · Responses", baseUrl, path: "/v1/responses" },
    { id: "claude", name: "Claude · Messages", baseUrl: new URL("/", baseUrl).href.replace(/\/$/, ""), path: "/v1/messages" },
  ];
}
export function identifier(value, label) {
  if (typeof value !== "string" || !value.trim() || value.length > 256) throw fail(400, `${label} 必须是非空字符串，最多 256 个字符。`);
  return value;
}
export function textBlocks(value, types = ["text"], label = "消息内容") {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) throw fail(400, `${label} 必须是文本或文本内容块数组。`);
  return value.map((part) => {
    if (!object(part) || !types.includes(part.type) || typeof part.text !== "string")
      throw fail(400, `${label} 仅支持文本内容块，尚不支持图片、音频或文件。`);
    return part.text;
  }).join("\n");
}
export function argumentsObject(value) {
  let parsed;
  try { parsed = typeof value === "string" ? JSON.parse(value) : value; } catch {}
  if (!object(parsed)) throw fail(400, "工具调用参数必须是 JSON 对象。");
  return parsed;
}
export function validateHistory(messages) {
  if (!messages.length || messages.length > 1000) throw fail(400, "请提供 1–1000 条消息；续接历史也计入此限制。");
  const calls = new Set(), results = new Set();
  for (const message of messages) {
    for (const call of message.tool_calls || []) {
      if (calls.has(call.id)) throw fail(400, "工具调用 ID 不能重复。");
      calls.add(call.id);
    }
    if (message.role === "tool") {
      if (!calls.has(message.tool_call_id) || results.has(message.tool_call_id))
        throw fail(400, "工具结果必须对应历史中尚未回复的工具调用 ID。");
      results.add(message.tool_call_id);
    }
  }
  if (Buffer.byteLength(JSON.stringify(messages)) > 2 * 1024 * 1024) throw fail(413, "消息与续接历史超过 2 MiB 限制，请发送较短的对话。");
}
// A model-independent estimate for clients whose protocol requires numeric usage.
// This is visible-text accounting, not a claim about the upstream tokenizer or bill.
export function estimateTokens(text) {
  let ascii = 0, other = 0;
  for (const character of text) {
    if (character.codePointAt(0) < 128) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 4) + other;
}
export const inputTokens = (body) => estimateTokens(JSON.stringify({ messages: body.messages, tools: body.tools || [] }));
export const jsonResponse = (body, headers = {}) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json", ...headers } });
export const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

// Consume the existing completion engine instead of opening a second upstream request.
// Completion is committed only after its real terminal chunk AND [DONE] arrive.
export async function* chatChunks(response, signal) {
  const reader = response.body?.getReader();
  if (!reader) throw fail(502, "内部对话响应缺少正文。");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "", finished = false;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      if (signal?.aborted) throw signal.reason;
      const packet = await reader.read();
      if (signal?.aborted) throw signal.reason;
      if (packet.done) throw fail(502, "内部对话在正式结束之前断开。");
      buffer += decoder.decode(packet.value, { stream: true });
      for (;;) {
        const delimiter = /\r?\n\r?\n/.exec(buffer);
        if (!delimiter) break;
        const block = buffer.slice(0, delimiter.index);
        buffer = buffer.slice(delimiter.index + delimiter[0].length);
        const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (!data) continue;
        if (data === "[DONE]") {
          if (!finished) throw fail(502, "内部对话缺少结束原因。");
          return;
        }
        let value;
        try { value = JSON.parse(data); } catch { throw fail(502, "内部对话事件格式异常。"); }
        const choice = value?.choices?.[0];
        if (!choice || !object(choice.delta)) throw fail(502, "内部对话事件缺少消息。");
        if (choice.finish_reason) finished = true;
        yield choice;
      }
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export function eventResponse(generate, { signal, errorFrame, headers = {}, source }) {
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const iterator = generate(combined)[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  let cancelled = false;
  return new Response(new ReadableStream({
    async pull(stream) {
      try {
        const part = await iterator.next();
        if (cancelled) return;
        if (part.done) stream.close();
        else stream.enqueue(encoder.encode(part.value));
      } catch (error) {
        if (cancelled) return;
        stream.enqueue(encoder.encode(errorFrame(signal?.aborted ? signal.reason : error)));
        stream.close();
      }
    },
    async cancel() {
      cancelled = true;
      controller.abort();
      // The generator can be cancelled before it ever acquires the source reader.
      await source?.body?.cancel().catch(() => {});
      await iterator.return?.();
    },
  }), { headers: { "content-type": "text/event-stream", ...headers } });
}
