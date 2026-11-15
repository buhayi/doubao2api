// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { defaultCaptchaPython, createLocalCaptchaSolver, captchaActions } from "../captcha.mjs";

const python = process.env.DW_CAPTCHA_PYTHON || defaultCaptchaPython;
const run = (script, capture = false) => new Promise((resolveRun, reject) => {
  const child = spawn(python, [fileURLToPath(new URL(script, import.meta.url))],
    { shell: false, windowsHide: true, stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit" });
  let output = "";
  child.stdout?.on("data", (part) => {
    output += part;
    if (output.length > 8 * 1024 * 1024) { child.kill(); reject(Error("测试图片超过大小限制。")); }
  });
  child.once("error", () => reject(Error("本地识别环境未就绪，请先运行 npm run captcha:setup。")));
  child.once("exit", (code) => code === 0 ? resolveRun(output) : reject(Error("本地识别测试未通过。")));
});

const solver = createLocalCaptchaSolver({ python });
try {
  await run("../captcha/tests.py");
  const fixtures = JSON.parse(await run("../captcha/fixtures.py", true));
  for (const fixture of fixtures) {
    const result = await solver.solve(fixture);
    if (fixture.kind === "slide") assert(Math.abs(result.x - fixture.expected.x) <= 3);
    else if (fixture.kind === "rotate") assert(Math.abs((result.angle - fixture.expected.angle + 540) % 360 - 180) <= 4);
    else {
      assert.equal(result.points.length, fixture.expected.points.length);
      for (const [index, point] of result.points.entries()) assert(Math.hypot(point.x-fixture.expected.points[index].x, point.y-fixture.expected.points[index].y) <= 6);
    }
    const actions = captchaActions({ ...fixture,
      background: { width: fixture.width, height: fixture.height, rect: { x: 40, y: 50, width: fixture.width/2, height: fixture.height/2 } },
      piece: { width: fixture.pieceWidth, height: fixture.pieceHeight },
      control: { knob: { x: 40, y: 220, width: 20, height: 20 }, track: { x: 40, y: 220, width: 170, height: 20 } },
    }, result);
    assert.equal(actions.type, fixture.kind === "click" ? "click" : "drag");
  }
  console.log("Node → Python 本地识别与坐标转换：滑块、旋转、顺序点选均通过。");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally { solver.dispose(); }
