// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";
import { fail } from "../protocol.mjs";
import { object, validateRequest, identifier, textBlocks, argumentsObject, validateHistory, jsonResponse, sse, chatChunks, eventResponse } from "./compat.mjs";

const id = (prefix) => prefix + "_" + randomUUID().replaceAll("-", "");
export function createResponseStore({ maxEntries = 128, maxBytes = 32 * 1024 * 1024, ttlMs = 30 * 60 * 1000, now = Date.now } = {}) {
  const entries = new Map();
  let bytes = 0;
  const remove = (key) => {
    const entry = entries.get(key);
    if (!entry) return false;
    bytes -= entry.bytes;
    return entries.delete(key);
  };
  const prune = () => { for (const [key, entry] of entries) if (entry.expiresAt <= now()) remove(key); };
  return {
    get(key) {
      prune();
      const entry = entries.get(key);
      if (!entry) throw fail(404, "响应不存在或已过期，请发送完整 input 历史；重启会清空响应缓存。");
      return entry;
    },
    put(response, history, uid) {
      prune();
      const size = Buffer.byteLength(JSON.stringify(response)) + Buffer.byteLength(JSON.stringify(history));
      if (size > maxBytes || maxEntries < 1) return false;
      remove(response.id);
      while (entries.size >= maxEntries || bytes + size > maxBytes) remove(entries.keys().next().value);
      entries.set(response.id, { response, history, uid, bytes: size, expiresAt: now() + ttlMs });
      bytes += size;
      return true;
    },
    remove,
    clear() { entries.clear(); bytes = 0; },
  };
}
export function normalizeResponses(value, previousHistory = []) {
  validateRequest(value);
  if (value.store != null && typeof value.store !== "boolean") throw fail(400, "store 必须是布尔值。");
  if (value.background != null && typeof value.background !== "boolean") throw fail(400, "background 必须是布尔值。");
  if (value.background) throw fail(400, "暂不支持后台 Responses，请使用普通 JSON 或 SSE 请求。");
  if (value.conversation) throw fail(400, "请使用 previous_response_id 或完整 input 历史续接对话。");
  if (value.previous_response_id !== undefined && value.previous_response_id !== null) identifier(value.previous_response_id, "previous_response_id");
  if (value.instructions !== undefined && value.instructions !== null && typeof value.instructions !== "string") throw fail(400, "instructions 必须是文本。");
  if (value.max_output_tokens !== undefined && value.max_output_tokens !== null && (!Number.isSafeInteger(value.max_output_tokens) || value.max_output_tokens < 1)) throw fail(400, "max_output_tokens 必须是正整数。");
  if (value.parallel_tool_calls != null && typeof value.parallel_tool_calls !== "boolean") throw fail(400, "parallel_tool_calls 必须是布尔值。");
  if (value.truncation && value.truncation !== "disabled") throw fail(400, "暂不支持自动截断，请缩短 input 或设置 truncation=disabled。");
  if (value.text != null && (!object(value.text) || (value.text.format != null && (!object(value.text.format) || value.text.format.type !== "text")))) throw fail(400, "Responses 目前仅支持 text 输出格式。");
  if (value.reasoning !== undefined && value.reasoning !== null && (!object(value.reasoning) || (value.reasoning.summary != null && !["auto", "concise", "detailed"].includes(value.reasoning.summary)))) throw fail(400, "reasoning 格式不正确。");
  if (value.metadata != null && (!object(value.metadata) || Object.entries(value.metadata).length > 16 || Object.entries(value.metadata).some(([key, v]) => key.length > 64 || typeof v !== "string" || v.length > 512))) throw fail(400, "metadata 最多 16 项，键最长 64 字符，字符串值最长 512 字符。");
  if (value.user != null && typeof value.user !== "string") throw fail(400, "user 必须是字符串。");
  const input = typeof value.input === "string" ? [{ role: "user", content: value.input }] : value.input;
  if (!Array.isArray(input) || !input.length || input.length > 1000) throw fail(400, "input 必须是文本或 1–1000 个输入项。");
  const history = structuredClone(previousHistory);
  for (const item of input) {
    if (!object(item)) throw fail(400, "input 中的输入项必须是对象。");
    const type = item.type || "message";
    if (type === "message") {
      if (!["system", "developer", "user", "assistant"].includes(item.role)) throw fail(400, "Responses 消息角色格式不正确。");
      history.push({ role: item.role, content: textBlocks(item.content, ["input_text", "output_text", "text"], "input 消息") });
    } else if (type === "function_call") {
      const call = { id: identifier(item.call_id, "call_id"), type: "function", function: { name: identifier(item.name, "工具名称"), arguments: JSON.stringify(argumentsObject(item.arguments)) } };
      const previous = history.at(-1);
      if (previous?.role === "assistant" && previous.content === null && previous.tool_calls) previous.tool_calls.push(call);
      else history.push({ role: "assistant", content: null, tool_calls: [call] });
    } else if (type === "function_call_output") {
      history.push({ role: "tool", tool_call_id: identifier(item.call_id, "call_id"), content: textBlocks(item.output, ["input_text", "text"], "工具输出") });
    } else if (type === "reasoning") {
      // Summary items may be replayed alongside the actual assistant message.
      // No opaque OpenAI reasoning state is forwarded to the unrelated upstream.
      if (item.summary !== undefined) textBlocks(item.summary, ["summary_text"], "思考摘要");
    } else throw fail(400, `尚不支持 ${type} 输入项，请使用文本和 function 工具。`);
  }
  const tools = value.tools ?? [];
  if (!Array.isArray(tools) || tools.length > 128) throw fail(400, "tools 最多包含 128 个函数工具。");
  const converted = tools.map((tool) => {
    if (!object(tool) || tool.type !== "function" || (tool.parameters !== undefined && !object(tool.parameters))) throw fail(400, "Responses 目前仅支持 function 工具及 JSON 对象参数定义。");
    return { type: "function", function: { name: identifier(tool.name, "工具名称"), ...(tool.description !== undefined ? { description: tool.description } : {}), parameters: tool.parameters || { type: "object", properties: {} } } };
  });
  let choice = value.tool_choice ?? "auto";
  if (object(choice)) {
    if (choice.type !== "function") throw fail(400, "tool_choice 仅支持已声明的 function 工具。");
    choice = { type: "function", function: { name: identifier(choice.name, "工具名称") } };
  }
  const messages = value.instructions ? [{ role: "developer", content: value.instructions }, ...history] : [...history];
  validateHistory(messages);
  return { history, body: { model: value.model, messages, stream: value.stream === true, tools: converted, tool_choice: choice,
    ...(value.parallel_tool_calls != null ? { parallel_tool_calls: value.parallel_tool_calls } : {}),
    ...(value.reasoning?.effort ? { reasoning_effort: value.reasoning.effort } : {}),
    ...(value.max_output_tokens ? { max_tokens: value.max_output_tokens } : {}),
  } };
}
function responseObject(request) {
  return { id: id("resp"), object: "response", created_at: Math.floor(Date.now() / 1000), completed_at: null, status: "in_progress", background: false,
    error: null, incomplete_details: null, instructions: request.instructions ?? null, max_output_tokens: request.max_output_tokens ?? null, model: request.model, output: [],
    parallel_tool_calls: request.parallel_tool_calls ?? true, previous_response_id: request.previous_response_id ?? null, reasoning: { effort: request.reasoning?.effort ?? null, summary: request.reasoning?.summary ?? null },
    store: request.store !== false, temperature: request.temperature ?? 1, text: { format: { type: "text" } }, tool_choice: request.tool_choice ?? "auto", tools: request.tools ?? [], top_p: request.top_p ?? 1,
    truncation: "disabled", usage: null, user: request.user ?? null, metadata: request.metadata ?? {}, service_tier: "default" };
}
const outputMessage = (text = "", status = "in_progress") => ({ id: id("msg"), type: "message", role: "assistant", status, content: [{ type: "output_text", text, annotations: [], logprobs: [] }] });
const outputFunction = (call, status = "in_progress") => ({ id: id("fc"), type: "function_call", status, call_id: call.id, name: call.function.name, arguments: call.function.arguments || "" });
export async function adaptResponses(completion, request, { signal, save, errorView, streamState = {} }) {
  const response = responseObject(request);
  streamState.sequence ??= 0;
  const event = (type, data) => sse(type, { ...data, sequence_number: streamState.sequence++ });
  const finish = (message) => {
    response.status = "completed";
    response.completed_at = Math.floor(Date.now() / 1000);
    if (response.store && !save(response, message)) response.store = false;
    return response;
  };
  if (!request.stream) {
    const result = await completion.json();
    const message = result.choices[0].message;
    if (request.reasoning?.summary && message.reasoning_content) response.output.push({ id: id("rs"), type: "reasoning", summary: [{ type: "summary_text", text: message.reasoning_content }] });
    if (message.content) response.output.push(outputMessage(message.content, "completed"));
    for (const call of message.tool_calls || []) response.output.push(outputFunction(call, "completed"));
    return jsonResponse(finish({ role: "assistant", content: message.content, ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}) }));
  }
  return eventResponse(async function* (combined) {
    yield event("response.created", { response });
    yield event("response.in_progress", { response });
    let message, reasoning;
    const calls = new Map();
    const indexOf = (item) => response.output.indexOf(item);
    for await (const { delta } of chatChunks(completion, combined)) {
      if (delta.reasoning_content && request.reasoning?.summary) {
        if (!reasoning) {
          reasoning = { id: id("rs"), type: "reasoning", summary: [{ type: "summary_text", text: "" }] };
          response.output.push(reasoning);
          yield event("response.output_item.added", { output_index: indexOf(reasoning), item: { ...reasoning, summary: [] } });
          yield event("response.reasoning_summary_part.added", { item_id: reasoning.id, output_index: indexOf(reasoning), summary_index: 0, part: { type: "summary_text", text: "" } });
        }
        reasoning.summary[0].text += delta.reasoning_content;
        yield event("response.reasoning_summary_text.delta", { item_id: reasoning.id, output_index: indexOf(reasoning), summary_index: 0, delta: delta.reasoning_content });
      }
      if (delta.content) {
        if (!message) {
          message = outputMessage();
          response.output.push(message);
          yield event("response.output_item.added", { output_index: indexOf(message), item: { ...message, content: [] } });
          yield event("response.content_part.added", { item_id: message.id, output_index: indexOf(message), content_index: 0, part: message.content[0] });
        }
        message.content[0].text += delta.content;
        yield event("response.output_text.delta", { item_id: message.id, output_index: indexOf(message), content_index: 0, delta: delta.content, logprobs: [] });
      }
      for (const call of delta.tool_calls || []) {
        let item = calls.get(call.index);
        if (!item) {
          item = outputFunction({ id: call.id, function: { name: call.function.name, arguments: "" } });
          calls.set(call.index, item);
          response.output.push(item);
          yield event("response.output_item.added", { output_index: indexOf(item), item });
        }
        if (call.function.arguments) {
          item.arguments += call.function.arguments;
          yield event("response.function_call_arguments.delta", { item_id: item.id, output_index: indexOf(item), delta: call.function.arguments });
        }
      }
    }
    if (combined.aborted) throw combined.reason;
    for (const [output_index, item] of response.output.entries()) {
      if (item.type === "message") {
        item.status = "completed";
        yield event("response.output_text.done", { item_id: item.id, output_index, content_index: 0, text: item.content[0].text, logprobs: [] });
        yield event("response.content_part.done", { item_id: item.id, output_index, content_index: 0, part: item.content[0] });
      } else if (item.type === "function_call") {
        item.status = "completed";
        yield event("response.function_call_arguments.done", { item_id: item.id, output_index, name: item.name, arguments: item.arguments });
      } else {
        yield event("response.reasoning_summary_text.done", { item_id: item.id, output_index, summary_index: 0, text: item.summary[0].text });
        yield event("response.reasoning_summary_part.done", { item_id: item.id, output_index, summary_index: 0, part: item.summary[0] });
      }
      yield event("response.output_item.done", { output_index, item });
    }
    const assistant = { role: "assistant", content: message?.content[0].text || null };
    if (calls.size) assistant.tool_calls = [...calls.values()].map((item) => ({ id: item.call_id, type: "function", function: { name: item.name, arguments: item.arguments } }));
    yield event("response.completed", { response: finish(assistant) });
  }, { signal, source: completion, errorFrame: (error) => responsesErrorFrame(errorView(error), streamState) });
}
export function responsesErrorFrame(view, state = {}) {
  state.sequence ??= 0;
  return sse("error", { code: view.body.error.code, message: view.body.error.message, param: null, sequence_number: state.sequence++ });
}
