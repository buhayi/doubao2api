// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";
import { fail } from "../protocol.mjs";
import { object, validateRequest, identifier, textBlocks, argumentsObject, validateHistory, estimateTokens, inputTokens, jsonResponse, sse, chatChunks, eventResponse } from "./compat.mjs";

export function normalizeMessages(value, { countOnly = false } = {}) {
  validateRequest(value);
  if (!countOnly && (!Number.isSafeInteger(value.max_tokens) || value.max_tokens < 1)) throw fail(400, "Claude Messages 需要正整数 max_tokens。");
  if (!Array.isArray(value.messages) || !value.messages.length || value.messages.length > 1000) throw fail(400, "请提供 1–1000 条 messages 消息。");
  if (value.stop_sequences !== undefined && (!Array.isArray(value.stop_sequences) || value.stop_sequences.length)) throw fail(400, "暂不支持自定义 stop_sequences，请省略或传入空数组。");
  if (value.output_config?.format && value.output_config.format.type !== "text") throw fail(400, "Claude Messages 目前仅支持文本输出。");
  if (value.thinking !== undefined && (!object(value.thinking) || !["disabled", "enabled", "adaptive", "between_tools"].includes(value.thinking.type))) throw fail(400, "thinking 格式不正确。");
  if (value.thinking?.type === "enabled" && (!Number.isSafeInteger(value.thinking.budget_tokens) || value.thinking.budget_tokens < 1)) throw fail(400, "thinking.budget_tokens 必须是正整数。");
  const messages = [];
  if (value.system !== undefined) messages.push({ role: "system", content: textBlocks(value.system, ["text"], "system") });
  for (const message of value.messages) {
    if (!object(message) || !["user", "assistant", "system"].includes(message.role)) throw fail(400, "Claude 消息角色必须是 user、assistant 或 system。");
    if (typeof message.content === "string" || message.role === "system") {
      messages.push({ role: message.role, content: textBlocks(message.content) });
      continue;
    }
    if (!Array.isArray(message.content) || !message.content.length) throw fail(400, "Claude 消息内容必须是文本或非空内容块数组。");
    let pending = { role: message.role, content: "" };
    const flush = () => { if (pending.content || pending.tool_calls) messages.push(pending); pending = { role: message.role, content: "" }; };
    for (const block of message.content) {
      if (!object(block)) throw fail(400, "Claude 内容块必须是对象。");
      if (block.type === "text") {
        if (typeof block.text !== "string") throw fail(400, "text 内容块需要字符串 text。");
        pending.content += (pending.content ? "\n" : "") + block.text;
      } else if (block.type === "tool_use" && message.role === "assistant") {
        pending.tool_calls ??= [];
        pending.tool_calls.push({ id: identifier(block.id, "tool_use.id"), type: "function", function: { name: identifier(block.name, "工具名称"), arguments: JSON.stringify(argumentsObject(block.input)) } });
      } else if (block.type === "tool_result" && message.role === "user") {
        flush();
        if (block.is_error !== undefined && typeof block.is_error !== "boolean") throw fail(400, "tool_result.is_error 必须是布尔值。");
        messages.push({ role: "tool", tool_call_id: identifier(block.tool_use_id, "tool_use_id"), content: (block.is_error ? "工具执行失败：\n" : "") + textBlocks(block.content ?? "", ["text"], "工具结果") });
      } else if (["thinking", "redacted_thinking"].includes(block.type) && message.role === "assistant") {
        // Signed Claude state cannot be resumed by Doubao. The text/tool history
        // remains usable, without inventing a signature or an upstream cache hit.
        if (block.type === "thinking" && typeof block.thinking !== "string") throw fail(400, "thinking 内容块需要字符串 thinking。");
        if (block.type === "redacted_thinking" && typeof block.data !== "string") throw fail(400, "redacted_thinking 内容块需要字符串 data。");
      } else throw fail(400, `尚不支持 ${block.type} 内容块，请使用文本、tool_use 和 tool_result。`);
    }
    flush();
  }
  validateHistory(messages);
  const tools = value.tools ?? [];
  if (!Array.isArray(tools) || tools.length > 128) throw fail(400, "tools 最多包含 128 个客户端工具。");
  const converted = tools.map((tool) => {
    if (!object(tool) || (tool.type && tool.type !== "custom") || !object(tool.input_schema)) throw fail(400, "目前仅支持带 input_schema 的客户端自定义工具。");
    return { type: "function", function: { name: identifier(tool.name, "工具名称"), parameters: tool.input_schema, ...(tool.description !== undefined ? { description: tool.description } : {}) } };
  });
  const choice = value.tool_choice ?? { type: "auto" };
  if (!object(choice) || !["auto", "none", "any", "tool"].includes(choice.type)) throw fail(400, "Claude tool_choice 格式不正确。");
  if (choice.disable_parallel_tool_use !== undefined && typeof choice.disable_parallel_tool_use !== "boolean") throw fail(400, "disable_parallel_tool_use 必须是布尔值。");
  return { model: value.model, messages, stream: value.stream === true, max_tokens: value.max_tokens, tools: converted,
    tool_choice: choice.type === "tool" ? { type: "function", function: { name: identifier(choice.name, "工具名称") } } : choice.type === "any" ? "required" : choice.type,
    parallel_tool_calls: !choice.disable_parallel_tool_use,
    ...(value.output_config?.effort ? { reasoning_effort: value.output_config.effort } : {}),
  };
}
export function anthropicError(view, requestId) {
  const type = view.status === 401 ? "authentication_error" : view.status === 403 ? "permission_error" : view.status === 404 ? "not_found_error"
    : view.status === 413 ? "request_too_large" : view.status === 429 ? "rate_limit_error" : view.status === 503 ? "overloaded_error" : view.status < 500 ? "invalid_request_error" : "api_error";
  return { type: "error", error: { type, message: view.body.error.message }, request_id: requestId };
}
export const anthropicErrorFrame = (view, requestId) => sse("error", anthropicError(view, requestId));
export async function adaptMessages(completion, body, { signal, errorView, requestId }) {
  const result = { id: "msg_" + randomUUID().replaceAll("-", ""), type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: inputTokens(body), output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } };
  const headers = { "x-doubao-usage": "estimated" };
  if (!body.stream) {
    const message = (await completion.json()).choices[0].message;
    if (message.content) result.content.push({ type: "text", text: message.content });
    for (const call of message.tool_calls || []) result.content.push({ type: "tool_use", id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments) });
    result.stop_reason = message.tool_calls ? "tool_use" : "end_turn";
    result.usage.output_tokens = estimateTokens(JSON.stringify(result.content));
    return jsonResponse(result, headers);
  }
  return eventResponse(async function* (combined) {
    yield sse("message_start", { message: result });
    let textIndex = null, toolUsed = false;
    for await (const { delta } of chatChunks(completion, combined)) {
      if (delta.content) {
        if (textIndex === null) {
          textIndex = result.content.length;
          result.content.push({ type: "text", text: "" });
          yield sse("content_block_start", { index: textIndex, content_block: { type: "text", text: "" } });
        }
        result.content[textIndex].text += delta.content;
        yield sse("content_block_delta", { index: textIndex, delta: { type: "text_delta", text: delta.content } });
      }
      for (const call of delta.tool_calls || []) {
        if (textIndex !== null) { yield sse("content_block_stop", { index: textIndex }); textIndex = null; }
        toolUsed = true;
        const index = result.content.length;
        const block = { type: "tool_use", id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments) };
        result.content.push(block);
        yield sse("content_block_start", { index, content_block: { ...block, input: {} } });
        yield sse("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: call.function.arguments } });
        yield sse("content_block_stop", { index });
      }
    }
    if (combined.aborted) throw combined.reason;
    if (textIndex !== null) yield sse("content_block_stop", { index: textIndex });
    result.stop_reason = toolUsed ? "tool_use" : "end_turn";
    result.usage.output_tokens = estimateTokens(JSON.stringify(result.content));
    yield sse("message_delta", { delta: { stop_reason: result.stop_reason, stop_sequence: null }, usage: { output_tokens: result.usage.output_tokens } });
    yield sse("message_stop", {});
  }, { signal, headers, source: completion, errorFrame: (error) => anthropicErrorFrame(errorView(error), requestId) });
}
