// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { setImmediate as nextTurn } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { createLocalCaptchaSolver, captchaActions, createCaptchaController } from "../captcha.mjs";
import { createCaptchaBrowser, CAPTCHA_EXPRESSION } from "../captcha-browser.mjs";

const deferred = () => Promise.withResolvers();
const request = { kind: "slide", background: "aW1hZ2U=", piece: "cGllY2U=", pieceX: 0, pieceY: 10 };
const result = { kind: "slide", x: 160, pieceWidth: 58, confidence: 0.9 };
const area = { x: 50, y: 60, width: 160, height: 85 };
const challenge = {
  kind: "slide", signature: "original", request,
  background: { url: "https://image.example.test/original", rect: area, width: 320, height: 170 },
  piece: { width: 58, height: 58 }, pieceX: 0,
  control: { track: { x: 50, y: 155, width: 170, height: 20 }, knob: { x: 50, y: 155, width: 20, height: 20 } },
};

function pngHeader(width, height) {
  const data = Buffer.alloc(33);
  Buffer.from("89504e470d0a1a0a", "hex").copy(data);
  data.writeUInt32BE(13, 8);
  data.write("IHDR", 12, "ascii");
  data.writeUInt32BE(width, 16);
  data.writeUInt32BE(height, 20);
  return data.toString("base64");
}
function domElement(selectors, box, props = {}) {
  return { selectors, box, children: [], style: { display: "block", visibility: "visible" }, textContent: "",
    getBoundingClientRect() { return this.box; },
    querySelectorAll(query) { return this.children.filter((child) => query.split(",").some((part) => child.selectors.includes(part.trim()))); },
    ...props,
  };
}
function domPage(nodes = [], url = "https://www.doubao.com/chat/") {
  const notices = [];
  const document = {
    querySelectorAll(query) { return nodes.filter((el) => query.split(",").some((part) => el.selectors.includes(part.trim()))); },
    getElementById(id) { return notices.find((notice) => notice.id === id) || null; },
    body: { appendChild(notice) { notices.push(notice); } },
    createElement(tag) {
      if (tag === "canvas") {
        let drawn;
        return { getContext: () => ({ drawImage: (img) => { drawn = img; } }), toDataURL: () => "data:image/png;base64,"+drawn.data };
      }
      return { style: {}, setAttribute() {}, remove() { notices.splice(notices.indexOf(this), 1); } };
    },
  };
  return { document, location: new URL(url), notices, getComputedStyle: (el) => el.style };
}
function domWidget(rootSelector = ".secsdk-captcha-wrapper", knobSelector = ".captcha_drag_icon") {
  const root = domElement([rootSelector], { x: 0, y: 0, width: 360, height: 280 }, { textContent: "拖动滑块完成拼图" });
  const background = domElement(["img", "img.captcha_verify_img_slide"], { x: 20, y: 30, width: 320, height: 170 },
    { src: "https://image.example.test/bg", naturalWidth: 320, naturalHeight: 170, complete: true, data: pngHeader(320, 170) });
  const piece = domElement(["img", "#captcha-verify-image2"], { x: 20, y: 80, width: 58, height: 58 },
    { src: "https://image.example.test/piece", naturalWidth: 58, naturalHeight: 58, complete: true, data: pngHeader(58, 58) });
  const track = domElement([".secsdk-captcha-drag-wrapper"], { x: 20, y: 222, width: 340, height: 30 });
  const knob = domElement([knobSelector], { x: 20, y: 222, width: 40, height: 30 }, { parentElement: track });
  root.children = [background, piece, track, knob];
  return { root, background, piece, track, knob };
}
function domFrame(view, { x = 100, y = 80, scale = 1, hidden = false } = {}) {
  return domElement(["iframe"], { x, y, width: 400*scale, height: 320*scale }, {
    src: view.location.href, contentDocument: view.document, contentWindow: view,
    offsetWidth: 400, offsetHeight: 320, clientLeft: 2, clientTop: 2, clientWidth: 396, clientHeight: 316,
    style: { display: hidden ? "none" : "block", visibility: "visible" },
  });
}
function evaluateDom(expression, view) {
  const value = runInNewContext(expression, { window: view, document: view.document, location: view.location });
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function worker() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.requests = [];
  child.killed = false;
  child.kill = () => { child.killed = true; };
  child.stdin.on("data", (data) => child.requests.push(JSON.parse(data.toString())));
  child.reply = (value) => child.stdout.write(JSON.stringify(value) + "\n");
  return child;
}
function fixture(t, overrides = {}) {
  const children = [];
  const solver = createLocalCaptchaSolver({
    accessFile: async () => {},
    spawnProcess(file, args, options) {
      assert.equal(options.shell, false);
      assert.equal(options.windowsHide, true);
      assert.deepEqual(options.stdio, ["pipe", "pipe", "ignore"]);
      assert.deepEqual(args.slice(0, 2), ["-I", "-u"]);
      const child = worker();
      children.push(child);
      setImmediate(() => { child.stdout.write('{"ready":'); child.stdout.write('true}\n'); });
      return child;
    },
    ...overrides,
  });
  t.after(() => solver.dispose());
  return { solver, children };
}

test("本地 IPC 串行识别，按请求编号接收分片响应，只传验证图片字段", async (t) => {
  const f = fixture(t);
  const first = f.solver.solve({ ...request, cookieHeader: "PRIVATE_COOKIE", apiKey: "PRIVATE_KEY" });
  const second = f.solver.solve(request);
  await nextTurn();
  await nextTurn();
  const child = f.children[0];
  assert.equal(child.requests.length, 1);
  assert.equal(f.solver.status().state, "solving");
  assert(!JSON.stringify(child.requests).includes("PRIVATE"));
  const id = child.requests[0].id;
  child.reply({ id, result });
  assert.deepEqual(await first, result);
  await nextTurn();
  assert.equal(child.requests.length, 2);
  assert(child.requests[1].id > id);
  child.reply({ id: child.requests[1].id, result });
  assert.deepEqual(await second, result);
  assert.equal(f.children.length, 1);
  assert.equal(f.solver.status().ready, true);
});

test("取消路径检查期间的识别与关闭服务，都不会迟到启动 Python", async (t) => {
  for (const mode of ["abort", "dispose"]) {
    const gate = deferred(), entered = deferred();
    const f = fixture(t, { accessFile: () => { entered.resolve(); return gate.promise; } });
    const controller = new AbortController();
    const task = f.solver.solve(request, { signal: controller.signal });
    const rejected = assert.rejects(task);
    await entered.promise;
    if (mode === "abort") controller.abort();
    else f.solver.dispose();
    gate.resolve();
    await rejected;
    assert.equal(f.children.length, 0);
    if (mode === "dispose") assert.equal((await f.solver.available()).state, "stopped");
  }
});

test("识别中取消会杀掉当前进程，排队请求用新进程继续且忽略旧响应", async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  const cancelled = f.solver.solve(request, { signal: controller.signal });
  const rejected = assert.rejects(cancelled, (e) => e.name === "AbortError");
  const following = f.solver.solve(request);
  await nextTurn();
  await nextTurn();
  controller.abort();
  await rejected;
  await nextTurn();
  await nextTurn();
  assert(f.children[0].killed);
  assert.equal(f.children.length, 2);
  const fresh = f.children[1];
  f.children[0].reply({ id: f.children[0].requests[0].id, result: { ...result, x: 999 } });
  fresh.reply({ id: fresh.requests[0].id, result });
  assert.deepEqual(await following, result);
});

test("异常识别输出和启动异常不回显图片、凭据或子进程错误", async (t) => {
  const f = fixture(t);
  const task = f.solver.solve(request);
  const rejected = assert.rejects(task, (e) => e.code === "captcha_unavailable" && !e.message.includes("PRIVATE"));
  await nextTurn();
  await nextTurn();
  f.children[0].stdout.write("PRIVATE_COOKIE_AND_IMAGE\n");
  await rejected;
  const broken = fixture(t, { spawnProcess: () => { throw Error("PRIVATE_PROCESS_DETAILS"); } });
  await assert.rejects(broken.solver.solve(request), (e) => e.code === "captcha_unavailable" && !e.message.includes("PRIVATE"));
});

test("图片格式、总大小和不合理数值在启动识别进程前被拒绝", async (t) => {
  const f = fixture(t);
  for (const value of [
    { ...request, background: "https://foreign.example.test/image" },
    { ...request, pieceX: Infinity },
    { ...request, instruction: "x".repeat(301) },
    { kind: "click", background: "A".repeat(2_700_000), targets: Array(4).fill("A".repeat(2_700_000)) },
  ]) await assert.rejects(f.solver.solve(value), (e) => e.code === "captcha_invalid");
  assert.equal(f.children.length, 0);
});

test("图片缩放转换为控件坐标，旋转按轨道计算，点选保留顺序", () => {
  const slide = captchaActions(challenge, result);
  assert.equal(slide.from.x, 60);
  assert(Math.abs(slide.to.x - (60 + 160 / 262 * 150)) < 0.001);
  const rotate = captchaActions({ ...challenge, kind: "rotate" }, { kind: "rotate", angle: 90, confidence: 0.8 });
  assert.equal(rotate.to.x, 97.5);
  const click = captchaActions({ ...challenge, kind: "click" }, { kind: "click", points: [{ x: 240, y: 60 }, { x: 80, y: 100 }], confidence: 0.9 });
  assert.deepEqual(click.points, [{ x: 170, y: 90 }, { x: 90, y: 110 }]);
  for (const invalid of [
    { ...result, x: -1 }, { ...result, x: 319 }, { ...result, confidence: 0.1 },
    { ...result, kind: "rotate" },
  ]) assert.throws(() => captchaActions(challenge, invalid));
  assert.throws(() => captchaActions({ ...challenge, kind: "click" }, { kind: "click", confidence: 0.9, points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] }));
});

test("同一验证码不重复提交，新图片也受单次流程尝试上限约束", async () => {
  let captures = 0, solves = 0, applications = 0;
  const controller = createCaptchaController({ maxAttempts: 2, solver: { solve: async () => { solves++; return result; } } });
  const browser = { captcha: {
    capture: async () => ({ ...challenge, signature: "image-" + captures }),
    apply: async () => { applications++; throw Error("官方尚未接受"); },
  } };
  await controller.inspect(browser);
  await controller.inspect(browser);
  assert.equal(solves, 1);
  captures++;
  await controller.inspect(browser);
  captures++;
  const exhausted = await controller.inspect(browser);
  assert.equal(solves, 2);
  assert.equal(applications, 2);
  assert.equal(exhausted.state, "manual");
  assert.equal(exhausted.attempts, 2);
});

test("控件移动或图片更新后丢弃旧坐标，点选提交前再次核对", async () => {
  let widget = structuredClone(challenge), clicks = 0;
  const browser = createCaptchaBrowser({ send: async (method, params) => {
    if (method === "Runtime.evaluate") return { result: { value: widget } };
    assert.equal(method, "Input.dispatchMouseEvent");
    if (params.type === "mousePressed") {
      clicks++;
      if (clicks === 1) widget.background.url += "-refreshed";
    }
    return {};
  } });
  const original = await browser.describe();
  widget.background.rect.x += 20;
  await assert.rejects(browser.apply(captchaActions(challenge, result), original.signature), /更新/);
  assert.equal(clicks, 0);
  widget = { ...structuredClone(challenge), kind: "click", submit: { x: 50, y: 155, width: 160, height: 30 } };
  const current = await browser.describe();
  const actions = captchaActions(widget, { kind: "click", points: [{ x: 80, y: 80 }], confidence: 0.9 });
  await assert.rejects(browser.apply(actions, current.signature), /更新/);
  assert.equal(clicks, 1);
});

test("真实 DOM 提取兼容 SecSDK 容器和滑块控件别名", () => {
  for (const [rootSelector, knobSelector] of [[".secsdk-captcha-wrapper", ".captcha_drag_icon"], [".sec-captcha-wrapper", ".sec-captcha-drag-icon"]]) {
    const widget = domWidget(rootSelector, knobSelector), view = domPage([widget.root]);
    const captured = evaluateDom(CAPTCHA_EXPRESSION, view);
    assert.equal(captured.kind, "slide");
    assert.equal(captured.frame, "main");
    assert.deepEqual(captured.control.knob, widget.knob.box);
    assert.equal(captured.pieceY, 50);
  }
});

test("同源 iframe 的边框、缩放和移动纳入页面坐标及旧结果核对", async () => {
  const widget = domWidget(), child = domPage([widget.root]);
  const hidden = domFrame(child, { hidden: true });
  const frame = domFrame(child, { scale: 1.5 });
  const empty = domElement(["#captcha_container"], { x: 0, y: 0, width: 100, height: 100 });
  const view = domPage([empty, hidden, frame]);
  let events = 0;
  const browser = createCaptchaBrowser({ send: async (method, params) => {
    if (method === "Runtime.evaluate") return { result: { value: evaluateDom(params.expression, view) } };
    events++;
    return {};
  } });
  const captured = await browser.capture();
  assert.equal(captured.frame, "main.1");
  assert.deepEqual(captured.background.rect, { x: 133, y: 128, width: 480, height: 255 });
  assert.equal(captured.background.width, 320);
  assert.equal(captured.request.pieceY, 50);
  assert.equal(captured.request.pieceScale, 1);
  const actions = captchaActions(captured, result);
  assert.deepEqual(actions.from, { x: 163, y: 438.5 });
  frame.box.x += 30;
  await assert.rejects(browser.apply(actions, captured.signature), /更新/);
  assert.equal(events, 0);
});

test("跨源验证 iframe 转为人工处理，隐藏 iframe 和其他站点不读取", () => {
  const child = domPage([], "https://verify.zijieapi.com/captcha"), frame = domFrame(child);
  frame.contentDocument = null;
  const view = domPage([frame]);
  assert.deepEqual(evaluateDom(CAPTCHA_EXPRESSION, view), { kind: "unsupported", frame: "main.0" });
  frame.style.display = "none";
  assert.equal(evaluateDom(CAPTCHA_EXPRESSION, view), null);
  assert.equal(evaluateDom(CAPTCHA_EXPRESSION, domPage([domWidget().root], "https://other.example.test/")), null);
});

test("截图回退使用 PNG 实际像素尺寸换算高 DPI 点选坐标", async () => {
  const widget = { kind: "click", background: { url: "https://image.example.test/click", width: 320, height: 200,
    rect: { x: 50, y: 60, width: 160, height: 100 } }, instruction: "依次点击", targets: [] };
  const browser = createCaptchaBrowser({ send: async (method, params) => {
    if (method === "Runtime.evaluate") return { result: { value: params.expression === CAPTCHA_EXPRESSION ? widget : null } };
    if (method === "Page.getResourceTree") throw Error("资源不可用");
    assert.equal(method, "Page.captureScreenshot");
    assert.deepEqual(params.clip, { x: 50, y: 60, width: 160, height: 100, scale: 1 });
    return { data: pngHeader(480, 300) };
  } });
  const captured = await browser.capture();
  assert.equal(captured.background.width, 480);
  assert.equal(captured.background.height, 300);
  assert.deepEqual(captchaActions(captured, { kind: "click", confidence: 0.9, points: [{ x: 240, y: 150 }] }).points, [{ x: 130, y: 110 }]);
});

test("人工回退只置前一次，保留官网控件，成功和关闭回调移除提示", async () => {
  const widget = domWidget(), view = domPage([widget.root]), calls = [];
  view.TTGCaptcha = { render: (options) => { view.renderOptions = options; } };
  const browser = createCaptchaBrowser({ send: async (method, params) => {
    calls.push(method);
    if (method === "Runtime.evaluate") return { result: { value: evaluateDom(params.expression, view) } };
    if (method === "Browser.getWindowForTarget") return { windowId: 7, bounds: { windowState: "minimized" } };
    if (method === "Browser.setWindowBounds") assert.deepEqual(params, { windowId: 7, bounds: { windowState: "normal" } });
    return {};
  } });
  const decision = { type: "verify", subtype: "slide" };
  assert.equal(await browser.show(decision), true);
  assert.equal(view.renderOptions.verify_data, JSON.stringify(decision));
  const controller = createCaptchaController();
  await controller.requestManual({ captcha: browser });
  await controller.requestManual({ captcha: browser });
  assert.equal(calls.filter((method) => method === "Page.bringToFront").length, 1);
  assert.equal(view.notices.length, 1);
  assert.match(view.notices[0].textContent, /需要人工验证/);
  assert.match(view.notices[0].style.cssText, /pointer-events:none/);
  assert.equal(widget.root.children.length, 4);
  view.renderOptions.captchaOptions.successCb();
  assert.equal(await browser.passed(), true);
  assert.equal(view.notices.length, 0);
  await browser.show(decision);
  await browser.requestManual();
  view.renderOptions.secondVerifyWebOptions.closeCallBack();
  assert.equal((await browser.outcome()).closed, true);
  assert.equal(view.notices.length, 0);
});

test("交给人工后不再截取图片或自动点击，等待官网确认后继续", async () => {
  let captures = 0, solves = 0, prompts = 0, passed = false;
  const browser = { captcha: {
    capture: async () => { captures++; return challenge; },
    describe: async () => passed ? null : challenge,
    passed: async () => passed,
    requestManual: async () => { prompts++; },
  } };
  const controller = createCaptchaController({ solver: { solve: async () => { solves++; throw Object.assign(Error("识别不可靠"), { code: "captcha_uncertain" }); } } });
  assert.equal((await controller.inspect(browser)).state, "manual");
  await controller.requestManual(browser);
  await controller.inspect(browser);
  await controller.requestManual(browser);
  assert.equal(captures, 1);
  assert.equal(solves, 1);
  assert.equal(prompts, 1);
  passed = true;
  assert.equal((await controller.inspect(browser)).solved, true);
});
