// SPDX-License-Identifier: AGPL-3.0-only
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { win32 } from "node:path";
import { promisify } from "node:util";
import { availableBrowsers } from "../browser-login.mjs";
import { envValue, windowsExecutable } from "../windows-browser.mjs";
import { fail } from "../protocol.mjs";

const exec = promisify(execFile);
const recovery = "在对应账号中完成验证后，请在账号管理台点击“探活”，通过后重试本次请求。";
const message = (state, importing = false) => (state === "foreground"
  ? "豆包工作已弹到前台。"
  : state === "attention"
    ? "豆包工作已恢复窗口；请点击任务栏中闪烁的豆包工作。"
    : "未能自动弹出豆包工作，请手动打开已安装的客户端。") + (importing
      ? "在对应账号中完成人工验证后，请运行 npm run import:work-client 重新导入登录。" : recovery);

// Launch the regular installed client, never the isolated sign-in browser.
// Only local paths reach the helper through stdin; no challenge or credentials.
export async function activateWorkClient({
  platform = process.platform, home = homedir(), env = process.env, signal,
  discover = availableBrowsers, execute = exec,
} = {}) {
  if (platform !== "win32") throw fail(400, "豆包工作客户端唤起仅支持 Windows。");
  if (signal?.aborted) throw signal.reason;
  const client = (await discover(platform, home, env)).find((item) => item.id === "doubaowork");
  const executable = windowsExecutable(client?.path, "DoubaoWork.exe");
  if (!executable) throw fail(404, "未找到已安装的豆包工作客户端，请检查 DW_DOUBAO_WORK_BIN。");
  const rawProfile = envValue(env, "DW_DOUBAO_WORK_PROFILE");
  let userDataDir = "";
  if (rawProfile) {
    if (typeof rawProfile !== "string" || rawProfile.length > 32767 || !/^[a-z]:[\\/]/i.test(rawProfile) || /[<>:\"|?*\x00-\x1f]/.test(rawProfile.slice(2)))
      throw fail(400, "DW_DOUBAO_WORK_PROFILE 必须是本机绝对目录。");
    const normalized = win32.normalize(rawProfile);
    if (normalized === win32.parse(normalized).root) throw fail(400, "DW_DOUBAO_WORK_PROFILE 必须是客户端专用目录。");
    userDataDir = normalized.replace(/[\\/]+$/, "");
  }
  if (signal?.aborted) throw signal.reason;
  const script = await readFile(new URL("./activate-work-client.ps1", import.meta.url), "utf8");
  const system = envValue(env, "SystemRoot") || "C:\\Windows";
  const powershell = win32.join(system, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  try {
    const task = execute(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
      shell: false, windowsHide: true, timeout: 15000, maxBuffer: 32 * 1024, encoding: "utf8", signal,
    });
    task.child.stdin.on("error", () => {});
    task.child.stdin.end(JSON.stringify({ executable, userDataDir }) + "\n");
    const result = JSON.parse((await task).stdout.trim());
    if (!["foreground", "attention"].includes(result?.state) || typeof result.launched !== "boolean") throw Error("Invalid activation result");
    return { state: result.state, launched: result.launched };
  } catch {
    if (signal?.aborted) throw signal.reason;
    throw fail(503, "豆包工作窗口唤起未完成，请手动打开客户端进行验证。");
  }
}

export function createClientVerificationManager({
  enabled = true, platform = process.platform, env = process.env,
  activate = activateWorkClient, now = Date.now, cooldownMs = 0,
  notify = (text) => console.warn(text),
} = {}) {
  const supported = enabled && platform === "win32";
  const shutdown = new AbortController();
  const accounts = new Map();
  const handled = new WeakSet();
  let pending, lastAttemptAt = null, lastResult, disposed = false;

  async function handle(account, error, { signal } = {}) {
    if (!supported || disposed || signal?.aborted || error?.reason !== "verification_required" || !account?.uid) return;
    if (handled.has(error)) return;
    handled.add(error);
    const uid = String(account.uid);
    const entry = { state: "opening", message: "正在唤起豆包工作，请准备人工验证。", requestedAt: now() };
    accounts.set(uid, entry);
    let task = pending;
    // Merge in-flight reminders, but a later rejection must restore the window again.
    if (!task && (cooldownMs <= 0 || lastAttemptAt === null || now() - lastAttemptAt >= cooldownMs)) {
      lastAttemptAt = now();
      task = Promise.resolve().then(() => {
        if (disposed) return { state: "cancelled" };
        return activate({ platform, env, signal: shutdown.signal });
      }).then((result) => ({ state: result?.state === "foreground" ? "foreground" : result?.state === "attention" ? "attention" : "error" }))
        .catch(() => ({ state: disposed ? "cancelled" : "error" }));
      pending = task;
      void task.then((result) => {
        lastResult = result;
        if (pending === task) pending = undefined;
        if (!disposed && result.state !== "cancelled") {
          try { notify(message(result.state)); } catch { /* Logging cannot replace the upstream error. */ }
        }
      });
    }
    const result = task ? await task : lastResult;
    if (disposed || result?.state === "cancelled") return;
    entry.state = result?.state === "foreground" ? "waiting" : result?.state === "attention" ? "attention" : "error";
    entry.message = message(result?.state, uid.startsWith("client:"));
    entry.updatedAt = now();
    if (signal?.aborted) return;
    const suffix = Number.isSafeInteger(error.upstreamCode) && error.upstreamCode > 0 ? `（上游代码 ${error.upstreamCode}）` : "";
    error.message = "豆包工作要求人工验证" + suffix + "，本次请求已停止。" + entry.message;
  }

  return {
    handle,
    verified: (uid) => accounts.delete(uid),
    status: () => ({ enabled: supported && !disposed, mode: supported ? "work-client-manual" : "disabled", automatic: false,
      cooldownMs, accounts: Object.fromEntries([...accounts].map(([uid, value]) => [uid, { ...value }])) }),
    async dispose() {
      disposed = true;
      shutdown.abort();
      await pending;
      accounts.clear();
      // The helper only owns its short-lived process. The user's client stays open.
    },
  };
}
