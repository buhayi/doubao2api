// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

// Run only in the dedicated Doubao target. Same-origin frames inherit the
// page's coordinates; inaccessible verification frames require manual input.
function locateWidget() {
  if (location.protocol !== "https:" || !["doubao.com", "www.doubao.com"].includes(location.hostname) || (location.port && location.port !== "443")) return null;
  const selectors = "#captcha_container,#captcha-verify-container,.captcha_verify_container,.captcha-verify-container,.secsdk-captcha,.secsdk-captcha-wrapper,.sec-captcha-wrapper";
  const scopes = [{ view: window, x: 0, y: 0, scaleX: 1, scaleY: 1, frame: "main", depth: 0 }];
  let pending = null;
  for (let i = 0; i < scopes.length && i < 32; i++) {
    const scope = scopes[i];
    let doc;
    try { doc = scope.view.document; } catch { continue; }
    const bounds = (el) => {
      const r = el.getBoundingClientRect();
      return { x: scope.x+r.x*scope.scaleX, y: scope.y+r.y*scope.scaleY, width: r.width*scope.scaleX, height: r.height*scope.scaleY };
    };
    const visible = (el) => {
      if (!el) return false;
      const r = bounds(el), s = scope.view.getComputedStyle(el), c = scope.clip;
      return [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 5 && r.height > 5 &&
        s.display !== "none" && s.visibility !== "hidden" && r.x >= 0 && r.y >= 0 &&
        (!c || (r.x >= c.x-0.5 && r.y >= c.y-0.5 && r.x+r.width <= c.x+c.width+0.5 && r.y+r.height <= c.y+c.height+0.5));
    };
    const roots = [...doc.querySelectorAll(selectors)].filter(visible);
    const root = roots.find((el) => [...el.querySelectorAll("img")].some((img) => visible(img) && img.complete && img.naturalWidth >= 12));
    if (root) return { root, doc, visible, bounds, frame: scope.frame };
    if (roots.length) pending ||= { root: roots[0], doc, visible, bounds, frame: scope.frame };
    const frames = [...doc.querySelectorAll("iframe")];
    for (let j = 0; j < frames.length && scopes.length < 32; j++) {
      const frame = frames[j];
      if (!visible(frame)) continue;
      const path = `${scope.frame}.${j}`;
      const verification = /captcha|verifycenter|verify\.zijieapi\.com/i.test(frame.src || "") || /验证码|人机验证/i.test(frame.title || "");
      try {
        const view = frame.contentWindow;
        if (scope.depth >= 8 || !frame.contentDocument || !view ||
            (view.location.origin !== location.origin && !/^about:(blank|srcdoc)$/.test(view.location.href))) throw Error();
        const r = frame.getBoundingClientRect();
        const scaleX = scope.scaleX*r.width/frame.offsetWidth, scaleY = scope.scaleY*r.height/frame.offsetHeight;
        const x = scope.x+r.x*scope.scaleX+frame.clientLeft*scaleX, y = scope.y+r.y*scope.scaleY+frame.clientTop*scaleY;
        const width = frame.clientWidth*scaleX, height = frame.clientHeight*scaleY;
        if (![x, y, width, height, scaleX, scaleY].every(Number.isFinite) || width <= 5 || height <= 5 || scaleX <= 0 || scaleY <= 0) throw Error();
        scopes.push({ view, x, y, scaleX, scaleY, frame: path, depth: scope.depth+1, clip: { x, y, width, height } });
      } catch {
        if (verification) pending ||= { frame: path };
      }
    }
  }
  return pending;
}

function inspectWidget(locate) {
  const scope = locate();
  if (!scope) return null;
  if (!scope.root) return { kind: "unsupported", frame: scope.frame };
  const { root, visible, bounds, frame } = scope;
  const find = (selectors) => [...root.querySelectorAll(selectors)].find(visible);
  const asset = (el) => el ? { url: el.currentSrc || el.src || "", width: el.naturalWidth || Math.round(el.getBoundingClientRect().width), height: el.naturalHeight || Math.round(el.getBoundingClientRect().height), rect: bounds(el) } : null;
  const images = [...root.querySelectorAll("img")].filter((el) => visible(el) && el.complete && el.naturalWidth >= 12);
  const backgroundEl = find("#captcha-verify-image,.captcha_verify_img--wrapper img,.captcha_verify_img img,.captcha-verify-image,img.captcha_verify_img_slide,.captcha_verify_img_slide img") || [...images].sort((a, b) => b.getBoundingClientRect().width*b.getBoundingClientRect().height-a.getBoundingClientRect().width*a.getBoundingClientRect().height)[0];
  if (!backgroundEl) return { kind: "unsupported", frame };
  const pieceEl = find("#captcha-verify-image2,.captcha_verify_img--tip img,.captcha-verify-image2");
  const text = (find(".captcha_verify_bar--text,.captcha_verify_bar--bar,.captcha-verify-title,.secsdk-captcha-title")?.textContent || root.textContent || "").trim().slice(0, 300);
  const knobEl = find("#captcha_slide_button,.secsdk-captcha-drag-icon,.captcha_drag_icon,.sec-captcha-drag-icon,.captcha_verify_slide--slidebar_button,.captcha-verify-slide-bar-button,[role=slider]");
  const trackEl = find("#secsdk-captcha-drag-wrapper,.secsdk-captcha-drag-wrapper,.captcha_verify_slide--slidebar,.captcha-verify-slide-bar") || knobEl?.parentElement;
  const kind = /旋转|转动|正向|rotate|rotation/i.test(text) ? "rotate"
    : /依次|点选|点击.*(?:图|字)|click|select/i.test(text) ? "click"
      : /滑块|拖动|拼图|slide|drag/i.test(text) || (knobEl && pieceEl) ? "slide" : "unsupported";
  const background = asset(backgroundEl), piece = asset(pieceEl);
  const extra = images.filter((el) => el !== backgroundEl && el !== pieceEl && el.getBoundingClientRect().height <= 90 && el.getBoundingClientRect().width <= 500);
  const buttons = [...root.querySelectorAll("button,[role=button],.captcha_verify_confirm")].filter(visible);
  const submit = buttons.find((el) => /^(确认|确定|提交|验证|Verify|Submit)$/i.test(el.textContent.trim()));
  const refresh = find(".captcha_verify_refresh,.captcha_verify_refresh--button,.secsdk-captcha-refresh,.captcha-verify-refresh");
  const error = find(".captcha_verify_tip--error,.captcha_verify_error,.secsdk-captcha-error,.captcha-verify-error");
  return { kind, frame, background, piece, instruction: text, targets: extra.map(asset).slice(0, 8),
    control: knobEl && trackEl ? { knob: bounds(knobEl), track: bounds(trackEl) } : null,
    ...(submit ? { submit: bounds(submit) } : {}),
    ...(refresh ? { refresh: bounds(refresh) } : {}),
    failed: Boolean(error && /错误|失败|重试|不正确|failed|incorrect/i.test(error.textContent)),
    pieceX: piece ? (piece.rect.x-background.rect.x)*background.width/background.rect.width : 0,
    pieceY: piece ? (piece.rect.y-background.rect.y)*background.height/background.rect.height : 0,
    pieceScale: piece ? (piece.rect.width/piece.width)/(background.rect.width/background.width) : 1 };
}

function captureWidgetImage(locate, url) {
  const scope = locate();
  if (!scope?.root) return null;
  const img = [...scope.root.querySelectorAll("img")].find((el) => scope.visible(el) && (el.currentSrc || el.src) === url);
  if (!img || !img.complete || img.naturalWidth < 12 || img.naturalHeight < 12 || img.naturalWidth > 1200 || img.naturalHeight > 1200) return null;
  try {
    const canvas = scope.doc.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext("2d").drawImage(img, 0, 0);
    return canvas.toDataURL("image/png").split(",")[1];
  } catch { return null; }
}

export const CAPTCHA_EXPRESSION = `(${inspectWidget.toString()})(${locateWidget.toString()})`;
const signatureOf = (widget) => widget?.background ? createHash("sha256").update(JSON.stringify({ kind: widget.kind,
  frame: widget.frame || "main",
  background: widget.background.url, piece: widget.piece?.url, targets: widget.targets?.map((item) => item.url),
  width: widget.background.width, height: widget.background.height, instruction: widget.instruction,
  area: widget.background.rect, pieceRect: widget.piece?.rect, control: widget.control, submit: widget.submit })).digest("hex") : "unsupported";
const validImage = (data) => typeof data === "string" && data.length > 0 && data.length <= 2*1024*1024*4/3+8 && /^[A-Za-z0-9+/]*={0,2}$/.test(data);

export function createCaptchaBrowser({ send } = {}) {
  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (exceptionDetails) throw Error("官网验证组件未就绪。");
    return result?.value;
  };
  async function describe() {
    const widget = await evaluate(CAPTCHA_EXPRESSION);
    return widget ? { ...widget, signature: signatureOf(widget) } : null;
  }
  async function pixels(asset) {
    if (!asset) throw Error("验证图片尚未加载。");
    const fromCanvas = await evaluate(`(${captureWidgetImage.toString()})(${locateWidget.toString()},${JSON.stringify(asset.url)})`);
    if (validImage(fromCanvas)) return { data: fromCanvas, width: asset.width, height: asset.height };
    try {
      const { frameTree } = await send("Page.getResourceTree");
      const content = await send("Page.getResourceContent", { frameId: frameTree.frame.id, url: asset.url });
      if (content.base64Encoded && validImage(content.content)) return { data: content.content, width: asset.width, height: asset.height };
    } catch { /* Loaded resource unavailable: use a tightly clipped widget image. */ }
    const { x, y, width, height } = asset.rect;
    if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width < 12 || height < 12 || width > 1200 || height > 1200)
      throw Error("验证图片范围不正确。");
    const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, clip: { x, y, width, height, scale: 1 } });
    if (!validImage(data)) throw Error("验证图片读取失败。");
    const png = Buffer.from(data, "base64");
    if (png.length < 33 || png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" || png.readUInt32BE(8) !== 13 || png.toString("ascii", 12, 16) !== "IHDR") throw Error("验证图片读取失败。");
    const pixelWidth = png.readUInt32BE(16), pixelHeight = png.readUInt32BE(20);
    if (pixelWidth < 12 || pixelHeight < 12 || pixelWidth > 1200 || pixelHeight > 1200 || pixelWidth*pixelHeight > 1_000_000) throw Error("验证图片尺寸不正确。");
    return { data, width: pixelWidth, height: pixelHeight, screenshot: true };
  }
  async function mouse(type, point, pressed = false) {
    await send("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: type === "mouseMoved" ? "none" : "left", buttons: pressed ? 1 : 0, ...(type === "mouseMoved" ? {} : { clickCount: 1 }) });
  }
  async function click(point, signal) {
    signal?.throwIfAborted();
    await mouse("mouseMoved", point);
    await mouse("mousePressed", point, true);
    try { await delay(70, undefined, { signal }); }
    finally { await mouse("mouseReleased", point); }
  }
  return {
    describe,
    async capture() {
      const widget = await describe();
      if (!widget) return null;
      if (!widget.background || widget.kind === "unsupported") return { ...widget, request: { kind: "unsupported" } };
      const bg = await pixels(widget.background);
      const part = widget.piece ? await pixels(widget.piece) : null;
      const prompt = widget.targets?.length === 1 ? await pixels(widget.targets[0]) : null;
      const targets = widget.targets?.length > 1 ? await Promise.all(widget.targets.map(pixels)) : [];
      const scale = bg.width/widget.background.width;
      return { ...widget, background: { ...widget.background, width: bg.width, height: bg.height },
        piece: widget.piece && { ...widget.piece, width: part.width, height: part.height },
        pieceX: widget.pieceX*scale,
        request: { kind: widget.kind, background: bg.data, ...(part ? { piece: part.data } : {}),
          instruction: widget.instruction, ...(prompt ? { prompt: prompt.data } : {}),
          ...(targets.length ? { targets: targets.map((item) => item.data) } : {}),
          pieceX: widget.pieceX*scale, pieceY: widget.pieceY*(bg.height/widget.background.height),
          pieceScale: part ? (widget.piece.rect.width/part.width)/(widget.background.rect.width/bg.width) : 1 } };
    },
    async apply(actions, signature, { signal } = {}) {
      signal?.throwIfAborted();
      if ((await describe())?.signature !== signature) throw Error("验证图片已更新，旧识别结果已丢弃。");
      if (actions.type === "click") {
        for (const point of actions.points) {
          if ((await describe())?.signature !== signature) throw Error("验证图片已更新。");
          await click(point, signal);
          await delay(160, undefined, { signal });
        }
        if (actions.submit) {
          if ((await describe())?.signature !== signature) throw Error("验证图片或控件位置已更新。");
          await click({ x: actions.submit.x+actions.submit.width/2, y: actions.submit.y+actions.submit.height/2 }, signal);
        }
      } else if (actions.type === "drag") {
        await mouse("mouseMoved", actions.from);
        await mouse("mousePressed", actions.from, true);
        let point = actions.from;
        try {
          for (let i = 1; i <= 30; i++) {
            signal?.throwIfAborted();
            const t = i/30, eased = t*t*(3-2*t);
            point = { x: actions.from.x+(actions.to.x-actions.from.x)*eased, y: actions.from.y };
            await mouse("mouseMoved", point, true);
            await delay(actions.durationMs/30, undefined, { signal });
          }
        } finally { await mouse("mouseReleased", point); }
      } else throw Error("验证操作类型不正确。");
    },
    async passed() { return evaluate("(function(){if(location.protocol!=='https:'||!['doubao.com','www.doubao.com'].includes(location.hostname))return false;var s=window.__dwVerificationState;return s?s.passed===true:null})()"); },
    async outcome() { return evaluate("(function(){if(location.protocol!=='https:'||!['doubao.com','www.doubao.com'].includes(location.hostname)||(location.port&&location.port!=='443'))return {closed:true};var s=window.__dwVerificationState;return s?{passed:s.passed===true,closed:s.closed===true,failed:s.failed===true}:null})()"); },
    async refresh(signature, { signal } = {}) {
      const widget = await describe();
      if (widget?.signature !== signature || !widget.refresh || !widget.failed) return false;
      await click({ x: widget.refresh.x+widget.refresh.width/2, y: widget.refresh.y+widget.refresh.height/2 }, signal);
      return true;
    },
    async show(decision) {
      // The official 4.x SDK is an initialized object. Its callbacks belong
      // inside captchaOptions, as used by the SDK's own request interceptor.
      return evaluate(`(function(){if(location.protocol!=='https:'||!['doubao.com','www.doubao.com'].includes(location.hostname)||(location.port&&location.port!=='443'))return false;var sdk=window.TTGCaptcha;if(!sdk||typeof sdk.render!=='function')return false;window.__dwVerificationState={passed:false};var success=function(){window.__dwVerificationState.passed=true},close=function(){window.__dwVerificationState.closed=true};sdk.render({verify_data:${JSON.stringify(JSON.stringify(decision))},captchaOptions:{successCb:success,closeCb:close,errorCb:function(){window.__dwVerificationState.failed=true}},secondVerifyWebOptions:{callBack:success,closeCallBack:close}});return true})()`);
    },
  };
}
