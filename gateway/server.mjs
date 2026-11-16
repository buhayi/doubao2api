// SPDX-License-Identifier: AGPL-3.0-only
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createHash, timingSafeEqual, randomUUID } from "node:crypto";
import { createApi, fail } from "../protocol.mjs";
import { createCompletion } from "../completion.mjs";
import { createHistoryCleaner } from "./history.mjs";
import { beginAccountOperation, failedAccountHealth, isUpstreamFailure } from "./account-health.mjs";
import { validateApiKey } from "./config.mjs";
import { inputTokens, validateRequest } from "./compat.mjs";
import { createResponseStore, normalizeResponses, adaptResponses, responsesErrorFrame } from "./responses.mjs";
import { normalizeMessages, adaptMessages, anthropicError, anthropicErrorFrame } from "./anthropic.mjs";

const MAX_BODY = 2 * 1024 * 1024;
const digest = (value) => createHash("sha256").update(value).digest();
function authenticate(req, expected) {
  // Never forward the client key to Doubao. It only authorizes this local gateway.
  const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization || "")?.[1];
  const key = bearer || req.headers["x-api-key"];
  if (typeof key !== "string" || !timingSafeEqual(digest(key), expected))
    throw Object.assign(fail(401, "API Key 无效，请检查客户端配置。"), { code: "invalid_api_key" });
}
function errorView(error) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 502;
  const code = error?.code === "invalid_api_key" ? error.code
    : ["verification_required", "rate_limited", "session_expired", "upstream_error"].includes(error?.reason) ? error.reason
    : status === 401 ? "session_expired"
    : status === 429 ? "rate_limited"
    : status === 503 ? "account_unavailable"
    : status === 504 ? "request_timeout"
    : status < 500 ? "invalid_request" : "upstream_error";
  return { status, body: { error: {
    message: error?.status ? error.message : "请求未完成，请检查网关连接或重新登录豆包工作。",
    type: status === 401 ? "authentication_error" : status === 429 ? "rate_limit_error" : status < 500 ? "invalid_request_error" : "server_error",
    param: null,
    code,
    ...(Number.isSafeInteger(error?.upstreamCode) && error.upstreamCode > 0 ? { upstream_code: error.upstreamCode } : {}),
    ...(Number.isSafeInteger(error?.retryAfterSeconds) && error.retryAfterSeconds > 0 ? { retry_after_seconds: error.retryAfterSeconds } : {}),
  } } };
}
function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}
function readBody(req, signal) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    const cleanup = () => {
      req.removeListener("data", data);
      req.removeListener("end", end);
      req.removeListener("error", error);
      signal.removeEventListener("abort", abort);
    };
    const error = (err) => { cleanup(); reject(err); };
    const abort = () => error(signal.reason);
    const data = (part) => {
      size += part.length;
      if (size > MAX_BODY) {
        error(fail(413, "请求正文超过 2 MiB 大小限制。"));
        req.resume();
      } else parts.push(part);
    };
    const end = () => {
      cleanup();
      try { resolve(JSON.parse(Buffer.concat(parts).toString("utf8"))); }
      catch { reject(fail(400, "请求正文不是有效的 JSON。")); }
    };
    req.on("data", data);
    req.once("end", end);
    req.once("error", error);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
function validateBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw fail(400, "请求正文必须是 JSON 对象。");
  if (typeof body.model !== "string" || !body.model.trim() || body.model.length > 256) throw fail(400, "请提供模型 ID，可从 /v1/models 获取。");
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 1000) throw fail(400, "请提供 1–1000 条 messages 消息。");
  if (body.stream !== undefined && typeof body.stream !== "boolean") throw fail(400, "stream 必须是布尔值。");
  if (body.n !== undefined && body.n !== 1) throw fail(400, "当前仅支持 n=1 的单个回答。");
  // OpenAI defaults to a JSON response; the original plugin defaults to streaming.
  return { ...body, stream: body.stream === true };
}
function cors(req, res, allowed) {
  const origin = req.headers.origin;
  if (origin !== undefined) {
    if (!allowed.includes("*") && !allowed.includes(origin)) throw fail(403, "浏览器来源未获授权，请配置 DW_CORS_ORIGINS。");
    res.setHeader("Access-Control-Allow-Origin", allowed.includes("*") ? "*" : origin);
    res.setHeader("Access-Control-Expose-Headers", "X-Request-ID, Request-ID, X-Doubao-Usage, X-Doubao-History, Retry-After");
    res.setHeader("Vary", "Origin");
  }
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-API-Key, Anthropic-Version, Anthropic-Beta, Anthropic-Dangerous-Direct-Browser-Access, X-Stainless-Lang, X-Stainless-Package-Version, X-Stainless-OS, X-Stainless-Arch, X-Stainless-Runtime, X-Stainless-Runtime-Version, X-Stainless-Retry-Count, X-Stainless-Timeout");
    res.setHeader("Access-Control-Max-Age", "600");
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}
export function createGateway({
  store, apiKey, api = createApi(), accountId, corsOrigins = [], promptTools = true, hideHistory,
  deleteHistory = hideHistory ?? true,
  timeoutMs = 120000, maxConcurrency = 3, heartbeatMs = 15000,
  responseCache = {}, historyCleanup = {}, edition = "gateway", clientVerification,
} = {}) {
  const expectedKey = digest(validateApiKey(apiKey));
  if (!store) throw Error("需要提供网关账号存储。");
  const shutdown = new AbortController();
  const active = new Map();
  const responses = createResponseStore(responseCache);
  const history = createHistoryCleaner({ api, ...historyCleanup });
  const verification = edition === "work-client" ? clientVerification : null;
  const server = createServer(async (req, res) => {
    const disconnected = new AbortController();
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(fail(504, "请求超时；网关不会自动重试，以免重复消耗额度。")), timeoutMs);
    timer.unref();
    const signal = AbortSignal.any([disconnected.signal, timeout.signal, shutdown.signal]);
    const abort = () => { if (!res.writableFinished) disconnected.abort(); };
    req.once("aborted", abort);
    req.on("error", abort); // IncomingMessage may emit an error after an interrupted upload.
    res.once("close", abort);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const requestId = "req_" + randomUUID().replaceAll("-", "");
    res.setHeader("X-Request-ID", requestId);
    let uid, heartbeat, protocol = "chat";
    let selectedAccount, startedAt, upstreamStarted = false, failureRecorded = false;
    const recordAccountFailure = async (error) => {
      if (!selectedAccount || !upstreamStarted || failureRecorded || signal.aborted || !isUpstreamFailure(error)) return;
      failureRecorded = true;
      // Persist the failure before a desktop helper waits for the window. New
      // callers must stop selecting this account as soon as verification fails.
      if (store.recordHealth) {
        try { await store.recordHealth(selectedAccount, failedAccountHealth(error, { source: "request", startedAt })); }
        catch { console.warn("账号失效状态未能保存，请检查本地账号文件和写入锁。"); }
      }
      await verification?.handle(selectedAccount, error, { signal });
    };
    const streamState = { sequence: 0 };
    try {
      if (!req.url?.startsWith("/") || req.url.startsWith("//")) throw fail(400, "请求地址格式不正确。");
      const url = new URL(req.url, "http://gateway.local");
      const path = url.pathname.replace(/\/$/, "");
      protocol = path === "/v1/responses" || path.startsWith("/v1/responses/") ? "responses"
        : path === "/v1/messages" || path.startsWith("/v1/messages/") ? "anthropic" : "chat";
      if (protocol === "anthropic") res.setHeader("request-id", requestId);
      if (cors(req, res, corsOrigins)) return;
      if (path === "/health" && req.method === "GET") return json(res, 200, { status: "ok" });
      authenticate(req, expectedKey);
      const storedResponse = /^\/v1\/responses\/([^/]+)$/.exec(path);
      let method;
      if (path === "/v1/models" || path.startsWith("/v1/models/") || path === "/v1/usage") method = "GET";
      else if (["/v1/chat/completions", "/v1/responses", "/v1/messages", "/v1/messages/count_tokens"].includes(path)) method = "POST";
      else if (storedResponse) method = "GET, DELETE";
      else throw fail(404, "接口不存在，请使用 /v1/models、/v1/chat/completions、/v1/responses 或 /v1/messages。");
      if (!method.split(", ").includes(req.method)) {
        res.setHeader("Allow", method);
        throw fail(405, `请使用 ${method} 请求此接口。`);
      }
      if (storedResponse) {
        let responseId;
        try { responseId = decodeURIComponent(storedResponse[1]); } catch { throw fail(400, "响应 ID 编码无效。"); }
        const saved = responses.get(responseId);
        if (req.method === "GET") return json(res, 200, saved.response);
        responses.remove(responseId);
        return json(res, 200, { id: responseId, object: "response", deleted: true });
      }
      let body, originalBody, normalized, previous;
      if (method === "POST") {
        if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || "")) throw fail(415, "请使用 Content-Type: application/json。");
        if (Number(req.headers["content-length"]) > MAX_BODY) throw fail(413, "请求正文超过 2 MiB 大小限制。");
        originalBody = await readBody(req, signal);
        if (protocol === "responses") {
          validateRequest(originalBody);
          if (originalBody.previous_response_id != null) {
            if (typeof originalBody.previous_response_id !== "string") throw fail(400, "previous_response_id 必须是字符串。");
            previous = responses.get(originalBody.previous_response_id);
          }
          normalized = normalizeResponses(originalBody, previous?.history);
          body = validateBody(normalized.body);
        } else if (protocol === "anthropic") {
          body = validateBody(normalizeMessages(originalBody, { countOnly: path.endsWith("/count_tokens") }));
          res.setHeader("X-Doubao-Usage", "estimated");
        } else body = validateBody(originalBody);
      }
      const account = await store.account(accountId);
      selectedAccount = account;
      startedAt = beginAccountOperation();
      if (signal.aborted) throw signal.reason;
      if (previous && previous.uid !== account.uid) throw fail(409, "默认账号已切换，请发送完整 input 历史开始新对话，或切回原账号续接。");
      if (path === "/v1/messages/count_tokens") {
        upstreamStarted = true;
        const catalog = await api.catalog(account.secret, { signal });
        if (!Object.hasOwn(catalog.models, body.model)) throw fail(404, "该账号当前模型目录没有这个模型，请刷新目录后重选。");
        return json(res, 200, { input_tokens: inputTokens(body) });
      }
      if (path === "/v1/usage") {
        upstreamStarted = true;
        return json(res, 200, await api.usage(account.secret, { signal }));
      }
      if (method === "GET") {
        upstreamStarted = true;
        const catalog = await api.catalog(account.secret, { signal });
        const models = Object.values(catalog.models).map((model) => ({
          id: model.id, object: "model", created: 0, owned_by: "doubaowork", name: model.name,
        }));
        if (path !== "/v1/models") {
          let id;
          try { id = decodeURIComponent(path.slice("/v1/models/".length)); }
          catch { throw fail(400, "模型 ID 编码无效。"); }
          const model = models.find((m) => m.id === id);
          if (!model) throw fail(404, "该账号没有这个模型，请刷新 /v1/models。");
          return json(res, 200, model);
        }
        return json(res, 200, { object: "list", data: models });
      }
      if ((active.get(account.uid) || 0) >= maxConcurrency) {
        res.setHeader("Retry-After", "1");
        throw fail(429, "这个账号正在处理其他对话，请稍后重试。");
      }
      uid = account.uid;
      active.set(uid, (active.get(uid) || 0) + 1);
      // Keep slow first tokens, reasoning and buffered tool replies from looking like a dead connection.
      // Delay the first heartbeat so fast validation/upstream failures retain their HTTP error status.
      if (body.stream && heartbeatMs > 0) {
        heartbeat = setInterval(() => {
          if (signal.aborted || res.destroyed || res.writableEnded || res.writableNeedDrain) return;
          if (!res.headersSent) res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "X-Accel-Buffering": "no",
          });
          res.write(": keep-alive\n\n"); // SSE comments are not fabricated model output.
        }, heartbeatMs);
        heartbeat.unref();
      }
      let historyOutcome = deleteHistory ? "auto-delete" : "retained";
      res.setHeader("X-Doubao-History", historyOutcome);
      upstreamStarted = true;
      let response = await createCompletion(api, account.secret, body, { signal, promptTools, idleMs: timeoutMs, onError: recordAccountFailure,
        cleanupConversation: deleteHistory ? async (conversation) => {
          historyOutcome = await history.clean(account.secret, conversation);
          return historyOutcome;
        } : undefined,
      });
      if (!res.headersSent) res.setHeader("X-Doubao-History", historyOutcome);
      const view = (error) => errorView(timeout.signal.aborted ? timeout.signal.reason : error);
      if (protocol === "responses") response = await adaptResponses(response, originalBody, { signal, streamState, errorView: view,
        save: (result, message) => responses.put(result, [...normalized.history, message], account.uid),
      });
      else if (protocol === "anthropic") response = await adaptMessages(response, body, { signal, errorView: view, requestId });
      if (signal.aborted) {
        await response.body?.cancel();
        throw signal.reason;
      }
      if (!res.headersSent) res.writeHead(response.status, {
        "Content-Type": response.headers.get("content-type") || "application/json",
        ...(body.stream ? { "X-Accel-Buffering": "no" } : {}),
      });
      if (response.body) await pipeline(Readable.fromWeb(response.body), res, { signal });
      else res.end();
    } catch (error) {
      await recordAccountFailure(error);
      if (disconnected.signal.aborted || shutdown.signal.aborted) { if (!res.destroyed) res.destroy(); }
      else if (res.headersSent) {
        // Heartbeats may already have committed HTTP 200 before an upstream error or timeout.
        // Report an explicit SSE error, never [DONE]. pipeline destroys truly truncated output.
        if (!res.destroyed && !res.writableEnded) {
          const view = errorView(timeout.signal.aborted ? timeout.signal.reason : error);
          res.end(protocol === "responses" ? responsesErrorFrame(view, streamState)
            : protocol === "anthropic" ? anthropicErrorFrame(view, requestId)
            : "data: " + JSON.stringify(view.body) + "\n\n");
        }
      }
      else {
        const view = errorView(timeout.signal.aborted ? timeout.signal.reason : error);
        if (view.body.error.code === "invalid_api_key") res.setHeader("WWW-Authenticate", "Bearer");
        if (Number.isSafeInteger(error?.retryAfterSeconds) && error.retryAfterSeconds > 0)
          res.setHeader("Retry-After", String(error.retryAfterSeconds));
        // Drain rejected uploads without buffering; closing before upload completion can hide the 413 from clients.
        req.resume();
        json(res, view.status, protocol === "anthropic" ? anthropicError(view, requestId) : view.body);
      }
    } finally {
      clearTimeout(timer);
      clearInterval(heartbeat);
      req.removeListener("aborted", abort);
      res.removeListener("close", abort);
      if (uid) {
        const count = active.get(uid) - 1;
        if (count) active.set(uid, count);
        else active.delete(uid);
      }
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.keepAliveTimeout = 5000;
  let closing;
  return {
    historyStatus: () => ({ enabled: deleteHistory, ...history.status() }),
    server,
    close() {
      return closing ??= (async () => {
        shutdown.abort();
        responses.clear();
        if (!server.listening) return;
        await new Promise((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
          server.closeAllConnections();
        });
      })();
    },
  };
}
