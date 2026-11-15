// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const root = fileURLToPath(new URL("./", import.meta.url));
export const defaultCaptchaPython = join(root, ".captcha-venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const problem = (code, message) => Object.assign(Error(message), { code });
const imageLimit = 2 * 1024 * 1024 * 4 / 3 + 8;
const imageValue = (value) => typeof value === "string" && value.length > 0 && value.length <= imageLimit && /^[A-Za-z0-9+/]*={0,2}$/.test(value);

export function createLocalCaptchaSolver({ enabled = true, python = defaultCaptchaPython, timeoutMs = 20000, spawnProcess = spawn, accessFile = access } = {}) {
  let worker, startup, startupReject, startingTimer, sequence = 0, pending, buffer = "", tail = Promise.resolve(), disposed = false;
  const info = { enabled, ready: false, state: enabled ? "unchecked" : "disabled", message: enabled ? "本地识别尚未检查。" : "自动验证已关闭。" };
  function stop(error) {
    clearTimeout(startingTimer);
    startupReject?.(error);
    startupReject = null;
    pending?.reject(error);
    pending = null;
    worker?.kill();
    worker = null;
    startup = null;
    buffer = "";
    info.ready = false;
    if (disposed) { info.state = "stopped"; info.message = "本地识别已停止。"; }
    else if (error?.code !== "captcha_unavailable") { info.state = "installed"; info.message = "本地识别已停止，将在下次验证时重新启动。"; }
  }
  async function start(signal) {
    signal?.throwIfAborted();
    if (disposed || !enabled) throw problem("captcha_disabled", "本地自动验证未启用。");
    if (startup) return startup;
    try { await accessFile(python); }
    catch {
      info.state = "unavailable";
      info.message = "请先运行 npm run captcha:setup 安装本地识别环境。";
      throw problem("captcha_unavailable", info.message);
    }
    // Cancellation can arrive while the interpreter path is being checked.
    // Recheck before creating a child, even if no worker existed at abort time.
    signal?.throwIfAborted();
    if (disposed || !enabled) throw problem("captcha_disabled", "本地自动验证未启用。");
    try {
      worker = spawnProcess(python, ["-I", "-u", join(root, "captcha", "solver.py")], {
        cwd: root, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "ignore"],
        env: { ...process.env, OMP_NUM_THREADS: "2", OPENBLAS_NUM_THREADS: "2" },
      });
    } catch {
      info.state = "unavailable";
      info.message = "本地识别进程无法启动，请检查 Python 路径和运行权限。";
      throw problem("captcha_unavailable", info.message);
    }
    info.state = "starting";
    info.message = "正在启动 CPU 本地识别。";
    startup = new Promise((resolveStart, reject) => {
      startupReject = reject;
      const current = worker;
      const failed = () => {
        if (worker !== current) return;
        info.state = "unavailable";
        info.message = "本地识别环境未就绪，请运行 npm run captcha:setup。";
        stop(problem("captcha_unavailable", info.message));
      };
      worker.once("error", failed);
      worker.once("exit", failed);
      worker.stdin.on("error", failed);
      worker.stdout.on("data", (part) => {
        if (worker !== current) return;
        buffer += part.toString("utf8");
        if (buffer.length > 65536) return failed();
        let end;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          let value;
          try { value = JSON.parse(line); } catch { failed(); return; }
          if (value?.ready === true && startupReject) {
            clearTimeout(startingTimer);
            startupReject = null;
            info.ready = true;
            info.state = "ready";
            info.message = "CPU 本地识别已就绪。";
            resolveStart();
          } else if (pending && value?.id === pending.id) {
            const request = pending;
            pending = null;
            if (value.error) request.reject(problem("captcha_uncertain", "本地识别未得到可靠结果，请完成当前验证或刷新验证图片。"));
            else request.resolve(value.result);
          } else { failed(); return; }
        }
      });
      startingTimer = setTimeout(failed, timeoutMs);
    });
    return startup;
  }
  async function recognize(request, signal) {
    signal?.throwIfAborted();
    if (!["slide", "rotate", "click"].includes(request?.kind) || !imageValue(request.background) ||
      ((request.kind === "slide" || request.kind === "rotate") && !imageValue(request.piece)) ||
      (request.prompt !== undefined && !imageValue(request.prompt)) ||
      (request.targets !== undefined && (!Array.isArray(request.targets) || request.targets.length > 8 || !request.targets.every(imageValue))) ||
      (request.instruction !== undefined && (typeof request.instruction !== "string" || request.instruction.length > 300)) ||
      ["pieceX", "pieceY", "pieceScale"].some((name) => request[name] !== undefined && (typeof request[name] !== "number" || !Number.isFinite(request[name]))))
      throw problem("captcha_invalid", "验证图片格式或大小不正确。");
    const input = Object.fromEntries(["kind", "background", "piece", "prompt", "targets", "instruction", "pieceX", "pieceY", "pieceScale"]
      .filter((name) => request[name] !== undefined).map((name) => [name, request[name]]));
    if (Buffer.byteLength(JSON.stringify(input)) > 10 * 1024 * 1024 - 64)
      throw problem("captcha_invalid", "验证图片总大小超过限制。");
    const abortStartup = () => stop(signal.reason || problem("captcha_cancelled", "验证已取消。"));
    signal?.addEventListener("abort", abortStartup, { once: true });
    try { await start(signal); }
    finally { signal?.removeEventListener("abort", abortStartup); }
    signal?.throwIfAborted();
    info.state = "solving";
    try {
      return await new Promise((resolveRequest, reject) => {
        const id = ++sequence;
        const current = worker;
        const fail = (error) => {
          if (worker !== current) return;
          if (error?.code === "captcha_unavailable") { info.state = "unavailable"; info.message = "本地识别进程已断开。"; }
          stop(error);
        };
        const timer = setTimeout(() => fail(problem("captcha_timeout", "本地验证码识别超时。")), timeoutMs);
        const abort = () => fail(signal.reason || problem("captcha_cancelled", "验证已取消。"));
        const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
        pending = { id, resolve: (value) => { cleanup(); resolveRequest(value); }, reject: (error) => { cleanup(); reject(error); } };
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) return abort();
        current.stdin.write(JSON.stringify({ ...input, id }) + "\n", (error) => { if (error) fail(problem("captcha_unavailable", "本地识别进程已断开。")); });
      });
    } finally { if (info.ready) info.state = "ready"; }
  }
  return {
    status: () => ({ ...info }),
    async available() {
      if (disposed) return { ...info };
      if (enabled && !info.ready) {
        try { await accessFile(python); if (!disposed && !info.ready) { info.state = "installed"; info.message = "本地识别环境已安装，将在验证时启动。"; } }
        catch { info.state = "unavailable"; info.message = "请先运行 npm run captcha:setup 安装本地识别环境。"; }
      }
      return { ...info };
    },
    solve(request, { signal } = {}) {
      const task = tail.then(() => recognize(request, signal));
      tail = task.catch(() => {});
      return task;
    },
    dispose() { disposed = true; stop(problem("captcha_cancelled", "本地识别已停止。")); },
  };
}

const finite = (value) => typeof value === "number" && Number.isFinite(value);
function rect(value) {
  if (!value || ![value.x, value.y, value.width, value.height].every(finite) ||
      value.width <= 0 || value.height <= 0 || value.width > 4096 || value.height > 4096 ||
      value.x < 0 || value.y < 0) throw problem("captcha_invalid", "验证控件坐标不正确。");
  return value;
}
export function captchaActions(challenge, result) {
  if (result?.kind !== challenge?.kind || !finite(result?.confidence) || result.confidence > 1 ||
      result.confidence < ({ slide: 0.36, rotate: 0.35, click: 0.52 }[challenge?.kind] || 1))
    throw problem("captcha_uncertain", "验证码识别置信度不足。");
  const bg = challenge.background;
  const area = rect(bg?.rect);
  if (!finite(bg.width) || !finite(bg.height) || bg.width < 12 || bg.height < 12 || bg.width > 1200 || bg.height > 1200)
    throw problem("captcha_invalid", "验证图片尺寸不正确。");
  if (result.kind === "click") {
    if (!Array.isArray(result.points) || result.points.length < 1 || result.points.length > 8)
      throw problem("captcha_invalid", "点选数量不正确。");
    const points = result.points.map((point) => {
      if (!finite(point?.x) || !finite(point?.y) || point.x < 0 || point.x >= bg.width || point.y < 0 || point.y >= bg.height)
        throw problem("captcha_invalid", "点选结果超出验证图片。");
      return { x: area.x + point.x * area.width / bg.width, y: area.y + point.y * area.height / bg.height };
    });
    if (points.some((p, i) => points.slice(0, i).some((q) => Math.hypot(p.x-q.x, p.y-q.y) < 3)))
      throw problem("captcha_invalid", "点选结果包含重复位置。");
    return { type: "click", points, ...(challenge.submit ? { submit: rect(challenge.submit) } : {}) };
  }
  const knob = rect(challenge.control?.knob), track = rect(challenge.control?.track);
  const travel = track.width - knob.width;
  if (travel < 20 || knob.x < track.x-2 || knob.x+knob.width > track.x+track.width+2)
    throw problem("captcha_invalid", "滑动控件范围不正确。");
  const from = { x: knob.x+knob.width/2, y: knob.y+knob.height/2 };
  let delta;
  if (result.kind === "rotate") {
    if (!finite(result.angle) || result.angle < 0 || result.angle >= 360) throw problem("captcha_invalid", "旋转角度不正确。");
    delta = result.angle/360 * travel - (knob.x-track.x);
  } else {
    const pieceWidth = result.pieceWidth ?? challenge.piece?.width;
    const offset = result.offsetX ?? 0;
    if (!finite(result.x) || !finite(pieceWidth) || !finite(offset) || pieceWidth < 10 || offset < 0 ||
        result.x < 0 || result.x+pieceWidth+offset > bg.width)
      throw problem("captcha_invalid", "滑块目标超出图片范围。");
    const current = challenge.pieceX || 0;
    const maximum = bg.width-pieceWidth-offset;
    if (maximum <= current) throw problem("captcha_invalid", "滑块图片范围不正确。");
    delta = (result.x-current)/(maximum-current) * (travel-(knob.x-track.x));
  }
  const to = { x: from.x+delta, y: from.y };
  if (to.x < track.x+knob.width/2-1 || to.x > track.x+track.width-knob.width/2+1)
    throw problem("captcha_invalid", "识别结果超出滑动范围。");
  return { type: "drag", from, to, durationMs: 1000 };
}

export function createCaptchaController({ solver, maxAttempts = 3, now = Date.now } = {}) {
  const attempts = new Map();
  let state = { state: "idle", attempts: 0, message: "" };
  let manual = false;
  return {
    status: () => ({ ...state }),
    async requestManual(browser, { signal, onStatus } = {}) {
      signal?.throwIfAborted();
      if (manual) return { ...state };
      manual = true;
      state = { ...state, state: "manual", message: "检测到人机验证，请在弹出的浏览器窗口中完成人工验证。" };
      onStatus?.({ ...state });
      try { await browser.captcha?.requestManual?.({ signal }); }
      catch (error) {
        if (signal?.aborted) throw error;
        state = { ...state, focusFailed: true, message: "需要人工验证，请切换到独立豆包窗口完成官网验证。" };
        onStatus?.({ ...state });
      }
      return { ...state };
    },
    async inspect(browser, { signal, onStatus } = {}) {
      signal?.throwIfAborted();
      if (manual) {
        const after = await browser.captcha?.describe?.();
        const passed = await browser.captcha?.passed?.();
        signal?.throwIfAborted();
        if (passed === true || (!after && passed !== false)) {
          state = { ...state, state: "solved", message: "人工验证已完成，正在核验账号会话。" };
          onStatus?.({ ...state });
          return { present: false, solved: true, ...state };
        }
        return { present: true, solved: false, ...state };
      }
      let challenge;
      try { challenge = await browser.captcha?.capture(); }
      catch (error) {
        if (signal?.aborted) throw error;
        let present = true;
        try { present = Boolean(await browser.captcha?.describe?.()); } catch { /* An unreadable widget still needs manual attention. */ }
        state = { state: "manual", attempts: attempts.size, message: "验证图片暂时无法读取，请在独立浏览器检查官网提示。" };
        onStatus?.({ ...state });
        return { present, solved: false, ...state };
      }
      signal?.throwIfAborted();
      if (!challenge) { attempts.clear(); state = { state: "idle", attempts: 0, message: "" }; return { present: false }; }
      const signature = challenge.signature || createHash("sha256").update(JSON.stringify({ kind: challenge.kind, background: challenge.request?.background })).digest("hex");
      let record = attempts.get(signature);
      if (record) return { present: true, solved: false, ...state };
      const count = attempts.size + 1;
      if (count > maxAttempts) {
        state = { state: "manual", attempts: maxAttempts, message: "本次自动验证尝试已用完，请完成官网验证。" };
        onStatus?.({ ...state });
        return { present: true, solved: false, ...state };
      }
      if (attempts.size >= 8) attempts.clear();
      record = { at: now() };
      attempts.set(signature, record);
      const update = (value) => { state = { ...value, kind: challenge.kind, attempts: count }; onStatus?.({ ...state }); };
      if (challenge.kind === "unsupported") {
        update({ state: "manual", message: "此验证码样式需要人工完成，请在独立浏览器中操作。" });
        return { present: true, solved: false, ...state };
      }
      update({ state: "solving", message: `正在本地识别${{ slide: "滑块", rotate: "旋转", click: "点选" }[challenge.kind] || "图片"}验证（${count}/${maxAttempts}）…` });
      try {
        if (!solver) throw problem("captcha_unavailable", "请先运行 npm run captcha:setup 安装本地识别环境。" );
        const result = await solver.solve(challenge.request, { signal });
        const actions = captchaActions(challenge, result);
        signal?.throwIfAborted();
        update({ state: "acting", message: "已完成本地识别，正在提交官网验证…" });
        await browser.captcha.apply(actions, signature, { signal });
        await delay(1400, undefined, { signal });
        const after = await browser.captcha.describe();
        const passed = await browser.captcha.passed?.();
        // A disappearing login widget is provisional: account import still
        // verifies the session. Recovery uses the SDK's success callback too.
        if (!after && passed !== false) {
          update({ state: "solved", message: "验证控件已完成，正在核验账号会话。" });
          attempts.clear();
          return { present: false, solved: true, ...state };
        }
        update({ state: "manual", message: "官网尚未确认验证通过，刷新验证图片后可再次自动识别，也可以手动完成。" });
        if (after?.failed && count < maxAttempts) await browser.captcha.refresh?.(signature, { signal });
      } catch (error) {
        if (signal?.aborted) throw error;
        update({ state: "manual", message: error?.code?.startsWith("captcha_") ? error.message : "自动验证未完成，请在独立浏览器检查官网提示。" });
      }
      return { present: true, solved: false, ...state };
    },
  };
}
