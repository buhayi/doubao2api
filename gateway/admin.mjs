// SPDX-License-Identifier: AGPL-3.0-only
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { createApi, fail } from "../protocol.mjs";
import { createLoginManager } from "../login.mjs";
import { createCompletion } from "../completion.mjs";
import { baseUrl } from "./config.mjs";
import { protocolOptions } from "./compat.mjs";
import { createHistoryCleaner } from "./history.mjs";
import { beginAccountOperation, failedAccountHealth } from "./account-health.mjs";

const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
  ["/app.mjs", ["app.mjs", "text/javascript; charset=utf-8"]],
  ["/ui.mjs", ["ui.mjs", "text/javascript; charset=utf-8"]],
]);
const digest = (value) => createHash("sha256").update(value).digest();
const activeStates = new Set(["starting", "waiting", "verifying", "awaiting_confirmation", "importing"]);
const reasonCodes = new Set(["session_expired", "rate_limited", "verification_required"]);

function errorView(error) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
  return { status, error: {
    message: error?.status ? error.message : "操作未完成，请检查本地服务或重新登录账号。",
    code: reasonCodes.has(error?.reason) ? error.reason : status === 401 ? "session_expired" : status === 429 ? "rate_limited" : "admin_error",
  } };
}
function send(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}
function localRequest(req, server, sensitive) {
  const address = req.socket.remoteAddress?.replace(/^::ffff:/, "");
  const port = server.address()?.port;
  if (!["127.0.0.1", "::1"].includes(address) || ![`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(req.headers.host))
    throw fail(403, "管理台仅接受本机访问。");
  const origin = `http://${req.headers.host}`;
  // Public assets must also open from bookmarks or links on another site.
  // The bootstrap and every management API still require same-origin access.
  if (sensitive && ((req.headers.origin && req.headers.origin !== origin) || (req.headers["sec-fetch-site"] && !["same-origin", "none"].includes(req.headers["sec-fetch-site"]))))
    throw fail(403, "管理请求来源不匹配，请从本机管理台操作。");
  if (!["GET", "HEAD"].includes(req.method) && req.headers.origin !== origin)
    throw fail(403, "管理操作需要同源请求。");
}
function body(req, signal) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || "")) throw fail(415, "请使用 JSON 请求。");
  if (Number(req.headers["content-length"]) > 8192) throw fail(413, "管理请求超过 8 KiB 限制。");
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    const cleanup = () => {
      req.removeListener("data", data);
      req.removeListener("end", end);
      req.removeListener("error", error);
      signal.removeEventListener("abort", abort);
    };
    const error = (value) => { cleanup(); reject(value); };
    const abort = () => { error(signal.reason); req.resume(); };
    const data = (part) => {
      size += part.length;
      if (size > 8192) { error(fail(413, "管理请求超过 8 KiB 限制。")); req.resume(); }
      else parts.push(part);
    };
    const end = () => {
      cleanup();
      try {
        const result = JSON.parse(Buffer.concat(parts).toString("utf8"));
        if (!result || typeof result !== "object" || Array.isArray(result)) throw fail(400, "请求正文必须是 JSON 对象。");
        resolve(result);
      } catch (value) { reject(value?.status ? value : fail(400, "请求正文不是有效的 JSON。")); }
    };
    req.on("data", data);
    req.once("end", end);
    req.once("error", error);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
function usageView(usage) {
  const fields = ["name", "used", "amount", "limit", "unit", "display", "aside", "balance", "resetsAt", "runsOutAt", "span"];
  return {
    plan: typeof usage?.plan === "string" ? usage.plan : "",
    windows: Array.isArray(usage?.windows) ? usage.windows.slice(0, 32).map((window) => Object.fromEntries(fields
      .filter((key) => ["string", "number", "boolean"].includes(typeof window?.[key]))
      .map((key) => [key, window[key]]))) : [],
  };
}

export function createAdmin({ store, api = createApi(), apiKey, config = {}, loginFactory = createLoginManager, health, historyStatus, clientVerification } = {}) {
  if (!store) throw Error("需要提供管理台账号存储。");
  const connection = baseUrl(config.host || "127.0.0.1", config.port || 8787);
  const token = randomBytes(32).toString("hex");
  const expectedToken = digest(token);
  const shutdown = new AbortController();
  const checks = new Map();
  const checking = new Map();
  const probing = new Map();
  const probeHistory = createHistoryCleaner({ api });
  const deleteHistory = config.deleteHistory ?? config.hideHistory ?? true;
  const verification = config.edition === "work-client" ? clientVerification : null;
  const checkVersions = new Map();
  let checkVersion = 0;
  let job = null;
  function rememberCheck(uid, result, version) {
    const previous = checks.get(uid);
    // An older detection must not replace a more recent result.
    if (previous?.updatedAt === result.updatedAt && (checkVersions.get(uid) || 0) > version) return previous;
    checks.set(uid, result);
    checkVersions.set(uid, version);
    return result;
  }

  function loginStatus() {
    if (!job) return { state: "idle", active: false };
    const current = job.active ? job.flow?.status?.() : null;
    return {
      id: job.id,
      state: current?.state && activeStates.has(current.state) ? current.state : job.state,
      active: job.active,
      message: current?.message || job.message || "",
      ...(job.active && job.flow?.url ? { url: job.flow.url } : {}),
      ...(current?.expiresAt ? { expiresAt: current.expiresAt } : {}),
      ...(job.result ? { result: job.result } : {}),
    };
  }
  function startLogin(options) {
    if (job?.active) throw fail(409, "已有登录流程，请先完成或取消当前登录。");
    if (options.browser && !["auto", "edge", "chrome", "doubao", "doubaowork", "chromium"].includes(options.browser)) throw fail(400, "不支持这个浏览器。");
    if (options.transport && !["pipe", "port"].includes(options.transport)) throw fail(400, "不支持这个浏览器连接方式。");
    const current = { id: randomBytes(12).toString("hex"), state: "starting", active: true, controller: new AbortController() };
    job = current;
    current.promise = (async () => {
      let manager;
      const signal = AbortSignal.any([current.controller.signal, shutdown.signal]);
      try {
        await store.list();
        if (signal.aborted) throw fail(499, "登录已取消。");
        manager = loginFactory({ root: store.root, api, standalone: true, browserEnv: { ...process.env, ...config.clientPaths } });
        const selectedBrowser = options.browser || config.defaultBrowser;
        current.flow = await manager.start({ browserId: selectedBrowser === "auto" ? undefined : selectedBrowser, transport: options.transport || "pipe", signal });
        current.state = "waiting";
        const result = await current.flow.callback(undefined, { signal });
        if (signal.aborted) throw fail(499, "登录已取消。");
        if (result?.type !== "success") throw fail(409, result?.error || "登录未完成，请重新发起。");
        current.result = await store.save(result);
        verification?.verified(current.result.uid);
        checks.delete(current.result.uid);
        checkVersions.delete(current.result.uid);
        current.state = "success";
        current.message = `已${current.result.updated ? "更新" : "添加"}账号：${current.result.name}`;
      } catch (error) {
        current.state = signal.aborted ? "cancelled" : "error";
        current.message = signal.aborted ? "本次登录已取消。" : errorView(error).error.message;
      } finally {
        try { await manager?.dispose(); }
        catch { if (current.state !== "success") current.message = "登录流程已结束，请检查临时浏览器窗口。"; }
        current.active = false;
      }
    })();
    return loginStatus();
  }
  async function checkAccount(uid, signal) {
    const account = await store.account(uid, { allowDisabled: true });
    const previous = checking.get(uid);
    if (previous?.updatedAt === account.updatedAt) return previous.promise;
    const version = ++checkVersion;
    const startedAt = beginAccountOperation();
    const promise = (async () => {
      let result;
      try {
        await api.identify(account.secret, { signal });
        result = { state: "ok", checkedAt: Date.now(), updatedAt: account.updatedAt };
        try { result.usage = usageView(await api.usage(account.secret, { signal })); }
        catch (error) {
          if (error?.localRateLimit) throw error;
          await verification?.handle(account, error, { signal });
          const view = errorView(error);
          result.usageError = view.error.message;
          result.state = failedAccountHealth(error, { source: "check", startedAt }).state;
          result.message = view.error.message;
        }
      } catch (error) {
        if (error?.localRateLimit) throw error;
        await verification?.handle(account, error, { signal });
        const view = errorView(error);
        result = { state: view.error.code === "session_expired" ? "expired" : view.error.code === "rate_limited" ? "limited" : view.error.code === "verification_required" ? "verification" : "error", message: view.error.message, checkedAt: Date.now(), updatedAt: account.updatedAt };
      }
      if (signal.aborted) throw signal.reason;
      if (result.state !== "ok") await store.recordHealth(account, {
        state: result.state, source: "check", startedAt, checkedAt: result.checkedAt, message: result.message,
      });
      return rememberCheck(uid, result, version);
    })();
    const pending = { updatedAt: account.updatedAt, promise };
    checking.set(uid, pending);
    try { return await promise; }
    finally { if (checking.get(uid) === pending) checking.delete(uid); }
  }
  async function probeAccount(uid, signal) {
    const account = await store.account(uid, { allowDisabled: true });
    const previous = probing.get(uid);
    if (previous?.updatedAt === account.updatedAt) return previous.promise;
    const startedAt = beginAccountOperation();
    const promise = (async () => {
      let result;
      try {
        const catalog = await api.catalog(account.secret, { signal, force: true });
        const models = Object.entries(catalog.models || {});
        const selected = models.find(([id, model]) => /flash|快速/i.test(`${id} ${model.name || ""}`)) || models[0];
        if (!selected) throw fail(502, "账号没有可用于探活的模型，请重新登录后再试。");
        // Metadata can remain accessible even when chat is unavailable. Require
        // a complete minimal reply and inspect upstream business/SSE errors.
        const response = await createCompletion(api, account.secret, {
          model: selected[0], messages: [{ role: "user", content: "hi" }], stream: false,
        }, { signal, promptTools: false, idleMs: 60000,
          cleanupConversation: deleteHistory ? (conversation) => conversation.conversationId
            ? probeHistory.clean(account.secret, conversation) : undefined : undefined,
        });
        await response.json();
        result = { state: "ok", source: "probe", startedAt, checkedAt: Date.now() };
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        if (error?.localRateLimit) throw error;
        await verification?.handle(account, error, { signal });
        result = failedAccountHealth(error, { source: "probe", startedAt });
      }
      if (signal.aborted) throw signal.reason;
      await store.recordHealth(account, result);
      if (result.state === "ok") verification?.verified(account.uid);
      const { startedAt: internalTime, ...publicResult } = result;
      return { ...publicResult, updatedAt: account.updatedAt };
    })();
    const pending = { updatedAt: account.updatedAt, promise };
    probing.set(uid, pending);
    try { return await promise; }
    finally { if (probing.get(uid) === pending) probing.delete(uid); }
  }
  async function overview(signal) {
    const list = await store.list();
    let online = false;
    try {
      online = health ? Boolean(await health()) : (await fetch(new URL("/health", connection), { signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]) })).ok;
    } catch { /* A stopped API gateway does not prevent account management. */ }
    const accounts = list.map((account) => {
      let check = checks.get(account.uid)?.updatedAt === account.updatedAt ? checks.get(account.uid) : { state: "unchecked" };
      if (account.health && (account.invalid || account.health.checkedAt >= (check.checkedAt || 0)))
        check = { ...check, ...account.health, updatedAt: account.updatedAt };
      if (account.health?.state === "ok" && check.source === "probe") {
        // A successful probe supersedes errors cached by a previous session or
        // quota check. It does not query quota itself.
        delete check.message;
        delete check.usageError;
      }
      return { ...account, check };
    });
    return { accounts, gateway: { online, baseUrl: connection, fixedAccountId: config.accountId || null,
      edition: config.edition || "gateway", defaultBrowser: config.defaultBrowser || "auto",
      ...(verification ? { clientVerification: verification.status() } : {}),
    }, login: loginStatus() };
  }

  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const disconnected = new AbortController();
    const abort = () => { if (!res.writableFinished) disconnected.abort(); };
    req.once("aborted", abort);
    req.on("error", abort);
    res.once("close", abort);
    const isProbe = /^\/api\/accounts\/[^/?]+\/probe(?:\?|$)/.test(req.url || "");
    const limit = isProbe ? 60000 : 30000;
    const signal = AbortSignal.any([shutdown.signal, disconnected.signal, AbortSignal.timeout(Math.min(config.timeoutMs || limit, limit))]);
    try {
      if (!req.url?.startsWith("/") || req.url.startsWith("//")) throw fail(400, "请求地址格式不正确。");
      const path = new URL(req.url, "http://admin.local").pathname;
      localRequest(req, server, path.startsWith("/api/"));
      if ((req.method === "GET" || req.method === "HEAD") && assets.has(path)) {
        const [file, type] = assets.get(path);
        const content = await readFile(new URL(`./admin/${file}`, import.meta.url));
        res.writeHead(200, { "Content-Type": type });
        return res.end(req.method === "HEAD" ? undefined : content);
      }
      if (path === "/avatar.png" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "image/png" });
        return res.end(await readFile(new URL("../avatar.png", import.meta.url)));
      }
      if (path === "/health" && req.method === "GET") return send(res, 200, { status: "ok" });
      if (path === "/api/session" && req.method === "GET") return send(res, 200, { token });
      if (!path.startsWith("/api/")) throw fail(404, "页面不存在。");
      const provided = req.headers["x-doubao-admin"];
      if (typeof provided !== "string" || !timingSafeEqual(digest(provided), expectedToken)) throw fail(403, "管理会话已失效，请刷新页面。");
      if (path === "/api/overview" && req.method === "GET") return send(res, 200, await overview(signal));
      if (path === "/api/settings" && req.method === "GET") return send(res, 200, {
        baseUrl: connection, adminPort: server.address().port, dataDir: store.root,
        edition: config.edition || "gateway", defaultBrowser: config.defaultBrowser || "auto",
        timeoutMs: config.timeoutMs || 120000, maxConcurrency: config.maxConcurrency || 3,
        upstreamRequests: api.requestStatus?.() || null,
        promptTools: config.promptTools !== false, fixedAccountId: config.accountId || null,
        invisibleSend: true, deleteHistory, hideHistory: deleteHistory, historyCleanup: historyStatus?.() || null,
        captcha: { enabled: false, mode: "disabled", automatic: false, manualFallback: false,
          message: "遇到官网人机验证时返回验证错误。" },
        ...(verification ? { clientVerification: verification.status() } : {}),
        protocols: protocolOptions(connection),
      });
      if (path === "/api/key" && req.method === "POST") {
        await body(req, signal);
        return send(res, 200, { apiKey: apiKey ?? await store.apiKey(config.apiKey) });
      }
      if (path === "/api/login" && req.method === "GET") return send(res, 200, loginStatus());
      if (path === "/api/login" && req.method === "POST") return send(res, 202, startLogin(await body(req, signal)));
      if (path === "/api/login/confirm" && req.method === "POST") {
        await body(req, signal);
        if (!job?.active || job.flow?.status?.().state !== "awaiting_confirmation" || !job.flow.confirm) throw fail(409, "请先在独立浏览器完成登录，再确认接入。");
        await job.flow.confirm();
        return send(res, 200, loginStatus());
      }
      if (path === "/api/login/cancel" && req.method === "POST") {
        await body(req, signal);
        if (job?.active) { job.controller.abort(); await job.promise; }
        return send(res, 200, loginStatus());
      }
      const match = /^\/api\/accounts\/([^/]+)(?:\/(default|check|probe|models))?$/.exec(path);
      if (match) {
        let uid;
        try { uid = decodeURIComponent(match[1]); } catch { throw fail(400, "账号 ID 编码无效。"); }
        if (!(await store.list()).some((account) => account.uid === uid)) throw fail(404, "这个账号已不存在，请刷新账号池。");
        const action = match[2];
        if (action === "models" && req.method === "GET") {
          const account = await store.account(uid, { allowDisabled: true });
          const startedAt = beginAccountOperation();
          let catalog;
          try { catalog = await api.catalog(account.secret, { signal, force: true }); }
          catch (error) {
            if (error?.localRateLimit) throw error;
            await verification?.handle(account, error, { signal });
            if (!signal.aborted) await store.recordHealth(account, failedAccountHealth(error, { source: "request", startedAt }));
            throw error;
          }
          return send(res, 200, { models: Object.values(catalog.models).map(({ id, name }) => ({ id, name })) });
        }
        if (action === "check" && req.method === "POST") { await body(req, signal); return send(res, 200, await checkAccount(uid, signal)); }
        if (action === "probe" && req.method === "POST") { await body(req, signal); return send(res, 200, await probeAccount(uid, signal)); }
        if (action === "default" && req.method === "POST") { await body(req, signal); await store.use(uid); return send(res, 200, { ok: true }); }
        if (!action && req.method === "PATCH") { await store.update(uid, await body(req, signal)); return send(res, 200, { ok: true }); }
        if (!action && req.method === "DELETE") { await body(req, signal); await store.remove(uid); checks.delete(uid); checkVersions.delete(uid); return send(res, 200, { ok: true }); }
        res.setHeader("Allow", action === "models" ? "GET" : action ? "POST" : "PATCH, DELETE");
        throw fail(405, "此接口不支持这个请求方法。");
      }
      throw fail(404, "管理接口不存在。");
    } catch (error) {
      if (disconnected.signal.aborted || shutdown.signal.aborted) { if (!res.destroyed) res.destroy(); }
      else if (!res.headersSent) {
        req.resume();
        const view = errorView(signal.aborted ? fail(504, "操作超时，请稍后重试。") : error);
        if (Number.isSafeInteger(error?.retryAfterSeconds) && error.retryAfterSeconds > 0)
          res.setHeader("Retry-After", String(error.retryAfterSeconds));
        send(res, view.status, { error: view.error });
      } else res.destroy();
    } finally {
      req.removeListener("aborted", abort);
      res.removeListener("close", abort);
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.keepAliveTimeout = 5000;
  let closing;
  return {
    server,
    close() {
      return closing ??= (async () => {
        shutdown.abort();
        job?.controller.abort();
        const closed = server.listening ? new Promise((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
          server.closeAllConnections();
        }) : Promise.resolve();
        await Promise.all([closed, job?.promise, ...[...checking.values(), ...probing.values()].map((pending) => pending.promise.catch(() => {}))]);
      })();
    },
  };
}
