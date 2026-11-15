// SPDX-License-Identifier: AGPL-3.0-only
import { mkdir, mkdtemp, chmod, rm, lstat } from "node:fs/promises";
import { resolve, join, relative, isAbsolute, basename } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { availableBrowsers, launchIsolatedBrowser, doubaoCookies } from "./browser-login.mjs";
import { protectWindowsProfile } from "./windows-browser.mjs";
import { credentials, credentialKey, verificationDecision } from "./protocol.mjs";
import { createCaptchaController } from "./captcha.mjs";

const accountUid = (secret) => `${secret.userId}:${secret.enterpriseType || "0"}`;
const sessionKey = (secret) => `${accountUid(secret)}:${credentialKey(secret)}`;

function waitFor(promise, signal) {
  signal?.throwIfAborted();
  if (!signal) return promise;
  return new Promise((resolveWait, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolveWait, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export function createVerificationManager({
  root, api, store, enabled = true, timeoutMs = 60000,
  manualFallback = true, manualTimeoutMs = 300000, pollMs = 600,
  browserId, transport = "pipe", discover = availableBrowsers, launch = launchIsolatedBrowser,
  protectProfile = (profile) => process.platform === "win32" ? protectWindowsProfile(profile) : chmod(profile, 0o700),
} = {}) {
  const temporaryRoot = join(resolve(root), "tmp");
  const shutdown = new AbortController();
  const pending = new Map(), states = new Map();
  const update = (uid, state) => {
    if (states.size >= 64 && !states.has(uid)) states.delete(states.keys().next().value);
    states.set(uid, { ...state, updatedAt: Date.now() });
  };
  async function run(secret, error, signal, publish) {
    const uid = accountUid(secret);
    let browser, profile, closed = true;
    let manualSignal;
    const report = (state) => { update(uid, state); publish(state); };
    try {
      signal.throwIfAborted();
      report({ state: "starting", message: "正在为当前账号打开独立验证窗口。" });
      await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
      const info = await lstat(temporaryRoot);
      if (!info.isDirectory() || info.isSymbolicLink()) throw Error("临时目录必须是项目私有的真实目录。");
      const choices = (await discover()).filter((choice) => !browserId || choice.id === browserId);
      if (!choices.length) throw Error("没有可用的验证浏览器。");
      let last;
      for (const choice of choices) {
        signal.throwIfAborted();
        profile = await mkdtemp(join(temporaryRoot, "doubao-verify-"));
        await protectProfile(profile);
        try {
          browser = await launch(choice, profile, { blank: true, transport });
          break;
        } catch (cause) {
          if (cause.cleanupPending) { closed = false; throw cause; }
          last = cause;
          await removeProfile(profile);
          profile = null;
        }
      }
      if (!browser) throw last;
      signal.throwIfAborted();
      await browser.restore(secret);
      let shown = false;
      const captcha = createCaptchaController();
      const show = async (phaseSignal) => {
        try { shown = await waitFor(browser.captcha.show(verificationDecision(error)), phaseSignal); }
        catch (cause) { if (phaseSignal.aborted) throw cause; }
      };
      const checkClosed = async (phaseSignal) => {
        const result = await waitFor(Promise.resolve(browser.captcha.outcome?.()), phaseSignal);
        if (result?.closed) throw Object.assign(Error("官网验证已关闭。"), { verificationClosed: true });
        return result;
      };
      signal.throwIfAborted();
      manualSignal = AbortSignal.any([signal, AbortSignal.timeout(manualTimeoutMs)]);
      const expiresAt = Date.now()+manualTimeoutMs;
      await waitFor(captcha.requestManual(browser, { signal: manualSignal,
        onStatus: (status) => report({ ...status, expiresAt }),
      }), manualSignal);
      for (;;) {
        manualSignal.throwIfAborted();
        if (!shown) await show(manualSignal);
        await checkClosed(manualSignal);
        if (shown && await waitFor(browser.captcha.passed(), manualSignal)) break;
        await delay(pollMs, undefined, { signal: manualSignal });
      }
      const confirmedSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
      report({ state: "verifying", message: "官网已确认验证通过，正在核验当前账号。" });
      const cookies = doubaoCookies(await waitFor(browser.cookies(), confirmedSignal));
      confirmedSignal.throwIfAborted();
      if (!cookies.length) throw Error("验证窗口没有当前账号的会话。");
      const identity = await waitFor(browser.identity(), confirmedSignal);
      confirmedSignal.throwIfAborted();
      const captured = credentials({ cookies, ...identity });
      const updated = await waitFor(api.identify({ ...secret, ...captured,
        deviceId: captured.deviceId || secret.deviceId || "",
        webId: captured.webId || secret.webId || "",
        fingerprint: captured.fingerprint || secret.fingerprint || "" }, { signal: confirmedSignal }), confirmedSignal);
      confirmedSignal.throwIfAborted();
      if (accountUid(updated) !== uid) throw Error("验证窗口的账号不一致。");
      if (store?.refreshSession) await store.refreshSession(uid, updated, { expectedCookieHeader: secret.cookieHeader });
      report({ state: "verified", message: "官网已确认验证，账号会话已更新。" });
      return updated;
    } catch (cause) {
      report({ state: signal.aborted ? "cancelled" : manualSignal?.aborted ? "expired" : "failed",
        message: signal.aborted ? "本次验证已取消。" : manualSignal?.aborted ? "人工验证等待已超时，请重新发起请求。" : cause?.verificationClosed ? "人工验证已关闭，本次请求未恢复。" : "验证未完成，请在管理台重新登录并检查官网提示。" });
      throw error;
    } finally {
      if (browser) {
        try { await browser.dispose(); }
        catch { closed = false; }
      }
      if (profile && closed) await removeProfile(profile).catch(() => { closed = false; });
      if (!closed) {
        const previous = states.get(uid) || {};
        update(uid, { ...previous, message: (previous.message || "")+" 临时验证窗口清理未完成，请关闭这次窗口后检查。", cleanupPending: true });
      }
    }
  }
  async function removeProfile(profile) {
    const path = resolve(profile), inside = relative(temporaryRoot, path);
    if (!inside || isAbsolute(inside) || inside.startsWith("..") || !basename(path).startsWith("doubao-verify-")) throw Error("验证临时目录不匹配。");
    await rm(path, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 });
  }
  return {
    status: () => ({ enabled, mode: "manual", automatic: false, manualFallback, manualTimeoutMs, accounts: Object.fromEntries(states) }),
    async recover(secret, error, { signal, onVerification } = {}) {
      signal?.throwIfAborted();
      if (!enabled || !manualFallback || error?.reason !== "verification_required" || !verificationDecision(error)) throw error;
      signal?.throwIfAborted();
      shutdown.signal.throwIfAborted();
      const key = sessionKey(secret);
      let operation = pending.get(key);
      if (!operation) {
        const controller = new AbortController();
        operation = { controller, users: 0, listeners: new Set() };
        pending.set(key, operation);
        const publish = (state) => {
          operation.lastState = { ...state };
          for (const listener of operation.listeners) { try { listener({ ...state }); } catch { /* UI notifications cannot change verification results. */ } }
        };
        operation.promise = Promise.resolve().then(() => run(secret, error, AbortSignal.any([controller.signal, shutdown.signal]), publish))
          .finally(() => { if (pending.get(key) === operation) pending.delete(key); });
      }
      operation.users++;
      const listener = typeof onVerification === "function" ? (state) => onVerification(state) : null;
      if (listener) {
        operation.listeners.add(listener);
        if (operation.lastState) { try { listener({ ...operation.lastState }); } catch { /* Notifications are optional. */ } }
      }
      try { return await waitFor(operation.promise, signal); }
      finally {
        if (listener) operation.listeners.delete(listener);
        if (--operation.users === 0) operation.controller.abort();
      }
    },
    async dispose() { shutdown.abort(); await Promise.allSettled([...pending.values()].map((operation) => operation.promise)); },
  };
}

export function withAutomaticVerification(api, manager) {
  const sessions = new Map(), retried = new WeakSet();
  function currentSession(secret) {
    const seen = new Set();
    for (;;) {
      const key = sessionKey(secret), next = sessions.get(key);
      if (!next || seen.has(key)) return secret;
      seen.add(key);
      secret = next;
    }
  }
  async function recover(secret, error, options) {
    const updated = await manager.recover(secret, error, options);
    const key = sessionKey(secret);
    if (sessions.size >= 64 && !sessions.has(key)) sessions.delete(sessions.keys().next().value);
    sessions.set(key, updated);
    return updated;
  }
  const wrapped = { ...api, recover, canRecover: (response) => !retried.has(response) };
  for (const name of ["post", "identify", "catalog", "usage"].filter((name) => typeof api[name] === "function")) wrapped[name] = async (secret, ...args) => {
    const current = currentSession(secret);
    try { return await api[name](current, ...args); }
    catch (error) {
      if (error?.reason !== "verification_required") throw error;
      const options = name === "post" ? args[2] || {} : args[0] || {};
      let updated;
      try { updated = await recover(current, error, options); }
      catch (recoveryError) {
        Object.defineProperty(recoveryError, "automaticVerificationAttempted", { value: true, configurable: true });
        throw recoveryError;
      }
      try {
        const result = await api[name](updated, ...args);
        if (result instanceof Response) retried.add(result);
        return result;
      } catch (retryError) {
        Object.defineProperty(retryError, "automaticVerificationAttempted", { value: true, configurable: true });
        throw retryError;
      }
    }
  };
  return wrapped;
}
