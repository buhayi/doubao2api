// SPDX-License-Identifier: AGPL-3.0-only
import { once } from "node:events";
import { parseArgs } from "node:util";
import { createApi, fail } from "../protocol.mjs";
import { createLoginManager } from "../login.mjs";
import { loadConfig, baseUrl } from "./config.mjs";
import { createStore } from "./store.mjs";
import { createGateway } from "./server.mjs";
import { createAdmin } from "./admin.mjs";
import { createVerificationManager, withAutomaticVerification } from "../verification.mjs";

const help = `豆包工作 · 通用 API 网关（Node.js 22+，无运行时 npm 依赖）

npm start                            启动网关及 8786 账号池管理台
npm run admin                        仅启动本机账号池管理台
npm run login                        独立浏览器登录 / 更新账号
npm run login -- --browser edge       指定 chrome / edge / doubao / chromium
npm run login -- --loopback           使用本机随机 CDP 端口兼容登录
npm run accounts                     列出账号（不会输出 Cookie）
node server.mjs use <uid>             切换默认账号，无需重启服务
node server.mjs remove <uid>          移除本地账号
node server.mjs enable <uid>          启用账号
node server.mjs disable <uid>         停用账号
npm run models                       查看当前账号的模型 ID
npm run usage                        查询账号额度
npm run key                          查看客户端 API Key

端口、密钥、数据目录等见 .env.example。客户端 Base URL 默认为
http://127.0.0.1:8787/v1，管理台为 http://127.0.0.1:8786。
支持 OpenAI Chat Completions、Responses 和 Claude Messages。
OpenAI 客户端 Base URL 带 /v1；Claude SDK 使用 http://127.0.0.1:8787。
API Key 是网关访问密钥，不是豆包 Cookie，也不是 OpenAI 官方密钥。`;

export async function runCli({
  argv = process.argv.slice(2), cwd = process.cwd(), env = process.env,
  io = console, signals = process, api = createApi(), loginFactory = createLoginManager, storeFactory = createStore,
} = {}) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true,
    options: { browser: { type: "string" }, loopback: { type: "boolean", default: false }, help: { type: "boolean", short: "h" } },
  });
  const [command = "serve", uid] = positionals;
  if (values.help || command === "help") { io.log(help); return; }
  const accountCommands = ["use", "remove", "enable", "disable"];
  if (!["serve", "admin", "login", "accounts", ...accountCommands, "models", "usage", "key"].includes(command)) throw fail(400, "未知命令，请运行 node server.mjs --help。");
  if (positionals.length > (accountCommands.includes(command) ? 2 : 1)) throw fail(400, "命令包含多余参数。");
  if (command !== "login" && (values.browser || values.loopback)) throw fail(400, "浏览器选项仅适用于 login 命令。");
  if (values.browser && !["chrome", "edge", "doubao", "chromium"].includes(values.browser)) throw fail(400, "browser 仅支持 chrome / edge / doubao / chromium。");
  if (accountCommands.includes(command) && !uid) throw fail(400, "请指定账号 uid，可从 npm run accounts 获取。");
  const config = await loadConfig({ cwd, env });
  const store = storeFactory(config.dataDir);
  if (command === "key") { io.log(await store.apiKey(config.apiKey)); return; }
  if (command === "accounts") { io.table(await store.list()); return; }
  if (command === "enable" || command === "disable") {
    await store.update(uid, { enabled: command === "enable" });
    io.log(command === "enable" ? "账号已启用。" : "账号已停用，后续网关请求不再使用此账号。");
    return;
  }
  if (command === "use" || command === "remove") {
    await store[command](uid);
    io.log(command === "use" ? "已切换默认账号。" : "已移除本地账号；其他账号不受影响。");
    if (config.accountId) io.warn("注意：DW_ACCOUNT_ID 已固定服务账号，优先于默认账号。");
    return;
  }
  const rawApi = api;
  const verification = createVerificationManager({ root: store.root, api: rawApi, store,
    enabled: config.captchaManualFallback,
    manualFallback: config.captchaManualFallback, manualTimeoutMs: config.captchaManualTimeoutMs,
    timeoutMs: config.captchaTimeoutMs,
    browserId: config.captchaBrowser, transport: config.captchaTransport });
  if (config.captchaManualFallback) api = withAutomaticVerification(rawApi, verification);
  const configuredLogin = (options) => loginFactory({ ...options, api: rawApi, captchaManualFallback: config.captchaManualFallback });
  if (command === "models" || command === "usage") {
    try {
      const { secret } = await store.account(config.accountId);
      if (command === "models") io.table(Object.values((await api.catalog(secret)).models).map(({ id, name }) => ({ id, name })));
      else io.log(JSON.stringify(await api.usage(secret), null, 2));
    } finally { await verification.dispose(); }
    return;
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  signals.once("SIGINT", stop);
  signals.once("SIGTERM", stop);
  try {
    if (command === "login") {
      await store.list(); // Secure/validate the dedicated data directory before opening a login window.
      const login = configuredLogin({ root: store.root, api, standalone: true });
      try {
        const flow = await login.start({ browserId: values.browser, signal: controller.signal, transport: values.loopback ? "port" : "pipe" });
        io.log("独立豆包登录窗口已打开。完成官网登录后，请在浏览器打开以下本机确认页面：");
        io.log(flow.url);
        io.log("确认页面点击“接入网关”，完成身份核验；Cookie 不会输出到终端。");
        const result = await flow.callback(undefined, { signal: controller.signal });
        if (result.type !== "success") throw fail(409, result.error || "登录未完成。");
        const saved = await store.save(result);
        io.log(`${saved.updated ? "已更新" : "已接入"}账号：${saved.name}（${saved.uid}）`);
        io.log("现在运行 npm start；已有网关进程会自动读取更新后的账号。");
      } finally { await login.dispose(); }
      return;
    }
    const apiKey = await store.apiKey(config.apiKey);
    if (command === "admin" && !config.adminPort) throw fail(400, "DW_ADMIN_PORT=0 已禁用管理台，请设置为 8786 或其他可用端口。");
    const gateway = command === "serve" ? createGateway({ ...config, store, api, apiKey }) : null;
    const admin = config.adminPort ? createAdmin({ store, api, apiKey, config, loginFactory: configuredLogin, historyStatus: gateway?.historyStatus,
      captchaStatus: async () => ({ enabled: config.captchaManualFallback, mode: "manual", automatic: false,
        state: config.captchaManualFallback ? "manual" : "disabled", manualFallback: config.captchaManualFallback,
        manualTimeoutMs: config.captchaManualTimeoutMs, verification: verification.status() }),
      verificationStatus: () => verification.status() }) : null;
    const services = [gateway, admin].filter(Boolean);
    const close = () => Promise.all(services.map((service) => service.close()));
    const cancel = () => { void close(); };
    try {
      if (gateway) {
        gateway.server.listen(config.port, config.host);
        await once(gateway.server, "listening");
      }
      if (admin) {
        admin.server.listen(config.adminPort, "127.0.0.1");
        await once(admin.server, "listening");
      }
      const closed = Promise.race(services.map((service) => once(service.server, "close")));
      controller.signal.addEventListener("abort", cancel, { once: true });
      if (controller.signal.aborted) { await close(); return; }
      if (gateway) {
        io.log("豆包工作 OpenAI 兼容网关已启动。");
        io.log(`Base URL: ${baseUrl(config.host, config.port)}`);
        io.log("API Key: 运行 npm run key 查看（启动日志不输出密钥）。");
      }
      if (admin) io.log(`账号池管理台: http://127.0.0.1:${config.adminPort}`);
      io.log(`数据目录: ${store.root}`);
      if (!(await store.list()).length) io.warn(admin ? "尚未登录账号，请在管理台点击“添加账号”。" : "尚未登录账号，请在另一个终端运行 npm run login。");
      if (gateway && !["127.0.0.1", "::1", "localhost"].includes(config.host)) io.warn("网关已绑定非回环地址；不要直接暴露公网，请配置防火墙和 HTTPS 反向代理。");
      if (controller.signal.aborted) await close();
      else await closed;
    } finally {
      controller.signal.removeEventListener("abort", cancel);
      await close();
    }
  } finally {
    await verification.dispose();
    signals.removeListener("SIGINT", stop);
    signals.removeListener("SIGTERM", stop);
  }
}
