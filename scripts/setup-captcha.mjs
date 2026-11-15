// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const root = fileURLToPath(new URL("../", import.meta.url));
const environment = join(root, ".captcha-venv");
const python = join(environment, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const { values } = parseArgs({ options: { python: { type: "string" } } });
const run = (file, args, capture = false) => new Promise((resolveRun, reject) => {
  const child = spawn(file, args, { cwd: root, shell: false, windowsHide: true,
    stdio: capture ? ["ignore", "pipe", "ignore"] : "inherit" });
  let output = "";
  child.stdout?.on("data", (part) => { if (output.length < 4096) output += part; });
  child.once("error", reject);
  child.once("exit", (code) => code === 0 ? resolveRun(output.trim()) : reject(Error("子进程未成功完成。")));
});

try {
  let exists = true;
  try { await access(python); } catch { exists = false; }
  if (!exists) {
    const explicit = values.python || process.env.DW_CAPTCHA_PYTHON;
    const candidates = explicit ? [[resolve(explicit), []]]
      : process.platform === "win32" ? [["py", ["-3.12"]], ["py", ["-3.11"]], ["python", []]]
        : [["python3", []], ["python", []]];
    let selected;
    for (const [file, args] of candidates) {
      try {
        const version = JSON.parse(await run(file, [...args, "-c", "import sys,json; print(json.dumps(list(sys.version_info[:2])))"], true));
        if (version[0] === 3 && version[1] >= 10 && version[1] <= 13) { selected = [file, args]; break; }
      } catch { /* Try the next installed interpreter. */ }
    }
    if (!selected) throw Error("需要 Python 3.10–3.13；可用 npm run captcha:setup -- --python <Python完整路径> 指定。 ");
    console.log("正在创建项目专用的本地验证码识别环境…");
    await run(selected[0], [...selected[1], "-m", "venv", environment]);
  }
  console.log("正在安装 CPU 图像库和本地 OCR 模型；运行时不调用识别 API…");
  await run(python, ["-m", "pip", "install", "--disable-pip-version-check", "--no-cache-dir", "-r", join(root, "captcha", "requirements.txt")]);
  await run(python, ["-I", "-c", "import cv2,numpy,PIL,ddddocr,onnxruntime; print('本地识别依赖已就绪。')"]);
  console.log("历史本地识别工具安装完成，可运行 npm run captcha:test；网关与浏览器登录不调用此环境。");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
