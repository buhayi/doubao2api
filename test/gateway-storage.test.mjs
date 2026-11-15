// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, stat } from "node:fs/promises";
import { join, resolve, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, validateApiKey, baseUrl } from "../gateway/config.mjs";
import { createStore } from "../gateway/store.mjs";
import { runCli } from "../gateway/cli.mjs";
import { saveAuth } from "../protocol.mjs";
import { createLoginManager } from "../login.mjs";

async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), "dw-gateway-test-"));
  assert.equal(dirname(root), resolve(tmpdir()));
  assert(basename(root).startsWith("dw-gateway-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const testSecurity = async (root) => mkdir(root, { recursive: true, mode: 0o700 });
const makeStore = (root) => createStore(root, { secureRoot: testSecurity });
const auth = (userId, cookie = "FIXTURE_COOKIE") => saveAuth({ cookieHeader: `sessionid=${cookie}`, userId, name: `账号-${userId}`, enterpriseType: "0" });

test("配置：零配置默认值、.env 与环境优先级、IPv6 地址", async (t) => {
  const cwd = await directory(t);
  const defaults = await loadConfig({ cwd, env: {} });
  assert.equal(defaults.host, "127.0.0.1");
  assert.equal(defaults.port, 8787);
  assert.equal(defaults.adminPort, 8786);
  assert.equal(defaults.dataDir, join(cwd, "data"));
  assert.equal(defaults.apiKey, undefined);
  assert.equal(defaults.promptTools, true);
  assert.equal(defaults.hideHistory, true);
  assert.equal(defaults.maxConcurrency, 3);
  assert.equal(defaults.autoCaptcha, false);
  assert.equal(defaults.captchaManualFallback, false);
  assert.equal(defaults.captchaManualTimeoutMs, undefined);
  await writeFile(join(cwd, ".env"), 'DW_PORT=9000\nDW_API_KEY="sk-env-fixture-123456"\nDW_DATA_DIR=private\nDW_CORS_ORIGINS=https://chat.example.test,http://localhost:3000\nDW_PROMPT_TOOLS=false\nDW_MAX_CONCURRENCY=2\n');
  assert.equal((await loadConfig({ cwd, env: {} })).maxConcurrency, 2);
  const config = await loadConfig({ cwd, env: { DW_PORT: "9001", DW_MAX_CONCURRENCY: "4", DW_HIDE_HISTORY: "false" } });
  assert.equal(config.port, 9001);
  assert.equal(config.apiKey, "sk-env-fixture-123456");
  assert.equal(config.dataDir, join(cwd, "private"));
  assert.equal(config.promptTools, false);
  assert.equal(config.maxConcurrency, 4);
  assert.equal(config.hideHistory, false);
  assert.deepEqual(config.corsOrigins, ["https://chat.example.test", "http://localhost:3000"]);
  assert.equal(baseUrl("0.0.0.0", 8787), "http://127.0.0.1:8787/v1");
  assert.equal(baseUrl("::1", 8787), "http://[::1]:8787/v1");
  const manual = await loadConfig({ cwd, env: { DW_AUTO_CAPTCHA: "false", DW_CAPTCHA_MANUAL_FALLBACK: "true", DW_CAPTCHA_MANUAL_TIMEOUT_MS: "120000" } });
  assert.equal(manual.autoCaptcha, false);
  assert.equal(manual.captchaManualFallback, false);
  assert.equal(manual.captchaManualTimeoutMs, undefined);
  assert.equal((await loadConfig({ cwd, env: { DW_AUTO_CAPTCHA: "true" } })).autoCaptcha, false);
  assert.equal((await loadConfig({ cwd, env: { DW_CAPTCHA_MANUAL_FALLBACK: "false" } })).captchaManualFallback, false);
});

test("配置：自定义密钥不要求长度或前缀，支持符号和内部空格", async (t) => {
  const cwd = await directory(t);
  for (const key of ["a", "0", "123", "test", "custom key #+/:=!", "x".repeat(1024)]) {
    assert.equal(validateApiKey(key), key);
    assert.equal((await loadConfig({ cwd, env: { DW_API_KEY: key } })).apiKey, key);
  }
  await writeFile(join(cwd, ".env"), 'DW_API_KEY="custom key #+/:=!"\n');
  assert.equal((await loadConfig({ cwd, env: {} })).apiKey, "custom key #+/:=!");
  assert.equal((await loadConfig({ cwd, env: { DW_API_KEY: "123" } })).apiKey, "123");
  assert.equal((await loadConfig({ cwd, env: { DW_API_KEY: "" } })).apiKey, undefined);
});

test("配置：拒绝无法通过请求头传输的密钥、异常端口、超时、并发数和来源地址", async (t) => {
  const cwd = await directory(t);
  for (const env of [
    { DW_API_KEY: "key\n" }, { DW_API_KEY: " key" }, { DW_API_KEY: "key " }, { DW_API_KEY: "中文" },
    { DW_PORT: "0" }, { DW_PORT: "65536" }, { DW_PORT: "8.1" }, { DW_PORT: "1e3" },
    { DW_HOST: "http://127.0.0.1:8787" }, { DW_TIMEOUT_MS: "1" }, { DW_MAX_CONCURRENCY: "0" },
    { DW_CORS_ORIGINS: "https://site.test/path" }, { DW_CORS_ORIGINS: "null" }, { DW_CORS_ORIGINS: "https://site.test/" },
    { DW_PROMPT_TOOLS: "yes" }, { DW_HIDE_HISTORY: "yes" }, { DW_HIDE_HISTORY: "1" }, { DW_DATA_DIR: "." }, { DW_DATA_DIR: ".." }, { DW_DATA_DIR: resolve(cwd, "../../") },
  ]) await assert.rejects(loadConfig({ cwd, env }));
  for (const key of [undefined, null, 123, "", " ", " key", "key ", "中文", "key\n", "key\r", "key\t", "key\0", "key\x7f"])
    assert.throws(() => validateApiKey(key), /DW_API_KEY/);
});

test("存储：私有目录初始化和持久化随机 API Key，显式密钥不覆盖自动密钥", async (t) => {
  const root = join(await directory(t), "private");
  const store = createStore(root); // Exercise real Windows ACL / POSIX permissions once.
  const key = await store.apiKey();
  assert.match(key, /^sk-dw-[a-f0-9]{64}$/);
  assert.equal(await store.apiKey(), key);
  assert.equal(await makeStore(root).apiKey(), key);
  assert.equal(await store.apiKey("123"), "123");
  assert.equal(await store.apiKey("custom key #+/:=!"), "custom key #+/:=!");
  assert.equal(await store.apiKey(), key);
  if (process.platform !== "win32") {
    assert.equal((await stat(root)).mode & 0o777, 0o700);
    assert.equal((await stat(join(root, "config.json"))).mode & 0o777, 0o600);
  }
  assert.deepEqual((await readdir(root)).sort(), [".gitignore", "config.json"]);
});

test("存储：已有的短密钥保持不变，不因格式变化重新生成", async (t) => {
  const root = await directory(t);
  const file = join(root, "config.json");
  const content = '{"version":1,"apiKey":"123"}';
  await writeFile(file, content);
  assert.equal(await makeStore(root).apiKey(), "123");
  assert.equal(await makeStore(root).apiKey(), "123");
  assert.equal(await readFile(file, "utf8"), content);
});

test("存储：移除签到后兼容旧记录目录，保留已有账号和记录", async (t) => {
  const root = await directory(t);
  const store = makeStore(root);
  await store.save(auth("a"));
  const accounts = await readFile(join(root, "accounts.json"), "utf8");
  const checkins = join(root, "checkins");
  await mkdir(checkins, { mode: 0o700 });
  const record = "legacy-checkin.json";
  const before = JSON.stringify({ day: "2026-11-14", state: "done" });
  await writeFile(join(checkins, record), before, { mode: 0o600 });
  assert.equal((await createStore(root).list())[0].uid, "a:0");
  assert.equal(await readFile(join(root, "accounts.json"), "utf8"), accounts);
  assert.equal(await readFile(join(checkins, record), "utf8"), before);
});

test("存储：名为 checkins 的普通文件仍被拒绝，不修改现有文件", async (t) => {
  const root = await directory(t);
  const file = join(root, "checkins");
  await writeFile(file, "existing user data");
  const mode = (await stat(file)).mode;
  await assert.rejects(createStore(root).list(), /签到记录/);
  assert.equal(await readFile(file, "utf8"), "existing user data");
  assert.equal((await stat(file)).mode, mode);
});

test("存储：多账号隔离、重复登录更新、热读取默认账号、移除及空账号错误", async (t) => {
  const root = await directory(t);
  const store = makeStore(root);
  await assert.rejects(store.account(), (e) => e.status === 503);
  assert.equal((await store.save(auth("a"))).updated, false);
  await store.save(auth("b", "B_COOKIE"));
  const other = makeStore(root);
  assert.equal((await other.account()).uid, "a:0");
  assert.equal((await store.save(auth("a", "NEW_A_COOKIE"))).updated, true);
  assert.equal((await other.account()).secret.cookieHeader, "sessionid=NEW_A_COOKIE");
  assert.equal((await store.account("b:0")).secret.cookieHeader, "sessionid=B_COOKIE");
  assert.equal((await store.list()).length, 2);
  assert(!JSON.stringify(await store.list()).includes("COOKIE"));
  await store.use("b:0");
  assert.equal((await other.account()).uid, "b:0");
  assert.equal((await store.account("a:0")).uid, "a:0");
  await store.remove("b:0");
  assert.equal((await other.account()).uid, "a:0");
  await store.remove("a:0");
  assert.deepEqual(await other.list(), []);
  await assert.rejects(store.account(), (e) => e.status === 503);
  assert(!((await readdir(root)).some((name) => name.endsWith(".tmp") || name.endsWith(".lock"))));
});

test("存储：数据损坏、身份不一致和写入锁都失败关闭，不覆盖现有文件", async (t) => {
  const root = await directory(t);
  const store = makeStore(root);
  await assert.rejects(store.save({ ...auth("a"), uid: "b:0" }), (e) => e.status === 400);
  await assert.rejects(store.save({ type: "failed" }), (e) => e.status === 400);
  await store.save(auth("a"));
  const file = join(root, "accounts.json");
  const before = await readFile(file, "utf8");
  await writeFile(join(root, "accounts.lock"), "fixture-lock");
  await assert.rejects(store.use("a:0"), (e) => e.status === 409);
  assert.equal(await readFile(file, "utf8"), before);
  await rm(join(root, "accounts.lock"));
  await assert.rejects(store.use("missing"), (e) => e.status === 404);
  assert.equal(await readFile(file, "utf8"), before);
  await writeFile(file, "{broken");
  await assert.rejects(store.save(auth("b")), /损坏/);
  assert.equal(await readFile(file, "utf8"), "{broken");
  await writeFile(join(root, "config.json"), '{"version":1,"apiKey":""}');
  await assert.rejects(store.apiKey(), /DW_API_KEY/);
  assert.equal(await readFile(join(root, "config.json"), "utf8"), '{"version":1,"apiKey":""}');
  await writeFile(join(root, "config.json"), "null");
  await assert.rejects(store.apiKey());
  assert.equal(await readFile(join(root, "config.json"), "utf8"), "null");
});

test("CLI：登录结果私有保存，浏览器参数传递，账号和模型输出无 Cookie", async (t) => {
  const cwd = await directory(t);
  const output = [];
  const io = { log: (...args) => output.push(args), warn: (...args) => output.push(args), table: (data) => output.push(data) };
  let disposed = false;
  const options = {
    cwd, env: {}, io, storeFactory: makeStore,
    loginFactory({ standalone }) {
      assert.equal(standalone, true);
      return {
        async start({ browserId, transport }) {
          assert.equal(browserId, "edge");
          assert.equal(transport, "port");
          return { url: "http://127.0.0.1:1/fixture/", callback: async () => auth("a") };
        },
        async dispose() { disposed = true; },
      };
    },
    api: { catalog: async (secret) => { assert.equal(secret.userId, "a"); return { models: { flash: { id: "flash", name: "测试模型" } } }; } },
  };
  await runCli({ ...options, argv: ["login", "--browser", "edge", "--loopback"] });
  assert(disposed);
  await runCli({ ...options, argv: ["accounts"] });
  await runCli({ ...options, argv: ["models"] });
  assert(!JSON.stringify(output).includes("FIXTURE_COOKIE"));
  assert(JSON.stringify(output).includes("flash"));
  assert.equal((await makeStore(join(cwd, "data")).account()).uid, "a:0");
  for (const argv of [["unknown"], ["use"], ["login", "--browser", "unknown"], ["models", "--loopback"], ["login", "extra"]])
    await assert.rejects(runCli({ ...options, argv }), (e) => e.status === 400);
});

test("CLI：失败登录不保存账号且始终清理浏览器", async (t) => {
  const cwd = await directory(t);
  let disposed = false;
  await assert.rejects(runCli({ argv: ["login"], cwd, env: {}, io: { log() {} }, storeFactory: makeStore,
    loginFactory: () => ({ start: async () => ({ url: "http://127.0.0.1:1/", callback: async () => ({ type: "failed", error: "登录取消" }) }), dispose: async () => { disposed = true; } }),
  }), /登录取消/);
  assert(disposed);
  assert.deepEqual(await makeStore(join(cwd, "data")).list(), []);
});

test("登录门户：独立网关文案，无 Magpie 依赖；原插件默认文案保持兼容", async (t) => {
  const root = await directory(t);
  class Browser {
    async start() {}
    status() { return { state: "waiting", active: true, message: "等待登录" }; }
    async dispose() {}
  }
  for (const standalone of [true, false]) {
    const manager = createLoginManager({ root, api: {}, Browser, standalone });
    try {
      const flow = await manager.start();
      const page = await (await fetch(flow.url)).text();
      const script = await (await fetch(flow.url + "flow.js")).text();
      assert.equal(page.includes("接入网关"), standalone);
      assert.equal(page.includes("Magpie"), !standalone);
      assert.equal(script.includes("Magpie"), !standalone);
      if (standalone) assert.match(page, /客户端通过 API Key 使用/);
    } finally { await manager.dispose(); }
  }
});

test("CLI：真实 HTTP 启动、未登录报错、日志无密钥、信号关停及监听器清理", async (t) => {
  const cwd = await directory(t);
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const signals = new EventEmitter();
  const output = [];
  let ready;
  const started = new Promise((resolve) => { ready = resolve; });
  const io = {
    log: (...args) => { output.push(args); if (String(args[0]).startsWith("Base URL:")) ready(); },
    warn: (...args) => output.push(args),
  };
  const key = "sk-cli-fixture-0123456789";
  const serving = runCli({ argv: ["serve"], cwd, env: { DW_PORT: String(port), DW_ADMIN_PORT: "0", DW_API_KEY: key }, io, signals, storeFactory: makeStore });
  try {
    await Promise.race([started, serving.then(() => { throw Error("网关启动前退出"); })]);
    const url = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(url + "/health")).status, 200);
    assert.equal((await fetch(url + "/v1/models")).status, 401);
    assert.equal((await fetch(url + "/v1/models", { headers: { Authorization: `Bearer ${key}` } })).status, 503);
    assert(!JSON.stringify(output).includes(key));
    assert.equal(signals.listenerCount("SIGTERM"), 1);
  } finally { signals.emit("SIGTERM"); await serving; }
  assert.equal(signals.listenerCount("SIGTERM"), 0);
  assert.equal(signals.listenerCount("SIGINT"), 0);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
});

test("存储：拒绝占用其他文件的目录，不改变文件或创建凭据", async (t) => {
  const root = await directory(t);
  const file = join(root, "unrelated.txt");
  await writeFile(file, "existing user data");
  const before = await stat(file);
  await assert.rejects(createStore(root).apiKey(), /专用目录/);
  assert.equal(await readFile(file, "utf8"), "existing user data");
  assert.equal((await stat(file)).mode, before.mode);
  assert.deepEqual(await readdir(root), ["unrelated.txt"]);
});

test("存储：超过文件大小限制的账号写入被拒绝，原有账号仍可读取", async (t) => {
  const root = await directory(t);
  const store = makeStore(root);
  const state = { version: 1, defaultUid: "0:0", accounts: [] };
  const record = (id) => ({ uid: `${id}:0`, name: `账号-${id}`, auth: { type: "oauth", access: auth(String(id), "A".repeat(65000)).access, refresh: "", expires: 0 }, updatedAt: 1 });
  for (let id = 0; ; id++) {
    const next = { ...state, accounts: [...state.accounts, record(id)] };
    if (Buffer.byteLength(JSON.stringify(next, null, 2) + "\n") > 2 * 1024 * 1024) break;
    state.accounts.push(record(id));
  }
  const before = JSON.stringify(state, null, 2) + "\n";
  const file = join(root, "accounts.json");
  await writeFile(file, before);
  await assert.rejects(store.save(auth("extra", "A".repeat(65000))), (e) => e.status === 413);
  assert.equal(await readFile(file, "utf8"), before);
  assert.equal((await store.list()).length, state.accounts.length);
});
