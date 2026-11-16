// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { decryptClientCookie, readClientCookieRows, readClientSessions, importClientAccounts, unprotectWindows } from "../desktop/sessions.mjs";
import { availableBrowsers, browserArgs } from "../browser-login.mjs";
import { runCli } from "../gateway/cli.mjs";
import { loadConfig } from "../gateway/config.mjs";
import { readAuth } from "../protocol.mjs";

const key = Buffer.alloc(32, 7);
function encryptedCookie(text, host = ".doubao.com", format = "v10") {
  const nonce = Buffer.alloc(12, 11), cipher = createCipheriv("aes-256-gcm", key, nonce);
  const plain = Buffer.concat([createHash("sha256").update(host).digest(), Buffer.from(text)]);
  return Buffer.concat([Buffer.from(format), nonce, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}
async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), "dw-client-test-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test("客户端 Cookie：v10/v11 解密并校验域，篡改密文或错误域不能导入", async () => {
  for (const format of ["v10", "v11"]) {
    const encrypted = encryptedCookie("PRIVATE_CLIENT_FIXTURE", ".doubao.com", format);
    assert.equal(await decryptClientCookie(encrypted, { key, host: ".doubao.com", hostBound: true }), "PRIVATE_CLIENT_FIXTURE");
    await assert.rejects(decryptClientCookie(encrypted, { key, host: "other.test", hostBound: true }), (error) => error.status === 401);
    const tampered = Buffer.from(encrypted);
    tampered[20] ^= 1;
    await assert.rejects(decryptClientCookie(tampered, { key, host: ".doubao.com", hostBound: true }), (error) => error.status === 401);
    await assert.rejects(decryptClientCookie(encrypted, { host: ".doubao.com" }), (error) => error.status === 401);
  }
});

test("客户端 Cookie：旧 DPAPI 可导入，v20 返回独立登录提示", async () => {
  assert.equal(await decryptClientCookie(Buffer.from("DPAPI_FIXTURE"), { unprotect: async () => Buffer.from("fixture_session") }), "fixture_session");
  await assert.rejects(decryptClientCookie(Buffer.from("v20_private"), { unprotect: () => assert.fail("must not decrypt") }), (error) => error.status === 409 && !error.message.includes("v20_private"));
});

test("Windows DPAPI：匿名 stdin 管道可解密当前用户的测试数据", { skip: process.platform !== "win32" }, async () => {
  const script = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $bytes=[Text.Encoding]::UTF8.GetBytes('public_fixture_32_bytes_1234567890'); [Console]::WriteLine([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))";
  const { stdout } = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true });
  const decrypted = await unprotectWindows(Buffer.from(stdout.trim(), "base64"));
  assert.equal(decrypted.toString(), "public_fixture_32_bytes_1234567890");
});

test("客户端安装：识别独立 Work 可执行文件、快捷方式运行时与显式路径", async () => {
  const runtime = "E:\\应用\\DoubaoWork\\app\\DoubaoWork.exe", launcher = "E:\\应用\\DoubaoWork\\DoubaoWork.exe";
  for (const explicit of [false, true]) {
    const found = await availableBrowsers("win32", "C:\\Users\\fixture", explicit ? { DW_DOUBAO_WORK_BIN: runtime } : {}, {
      usable: async (file) => [runtime, launcher].includes(file),
      readAppPaths: async () => ({ doubaowork: [launcher] }),
    });
    assert.deepEqual(found, [{ id: "doubaowork", name: "豆包工作客户端", path: runtime }]);
  }
  const proxy = "E:\\应用\\DoubaoWork\\app\\DoubaoWork_browser_proxy.exe";
  assert.deepEqual(await availableBrowsers("win32", "C:\\Users\\fixture", { DW_DOUBAO_WORK_BIN: proxy }, {
    usable: async (file) => file === proxy, readAppPaths: async () => ({}),
  }), []);
  assert.equal(browserArgs("C:\\tmp\\fixture", { id: "doubaowork" })[0], "--saman-browser-entry");
});

test("客户端数据库：仅读根域 Cookie，读取前后原数据库内容相同", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const root = await directory(t), file = join(root, "Cookies"), db = new DatabaseSync(file);
  db.exec("CREATE TABLE meta(key TEXT, value TEXT); INSERT INTO meta VALUES('version','24'); CREATE TABLE cookies(host_key TEXT,name TEXT,value TEXT,encrypted_value BLOB,path TEXT,expires_utc INTEGER,is_secure INTEGER)");
  const insert = db.prepare("INSERT INTO cookies VALUES(?,?,?,?,?,?,?)");
  insert.run(".doubao.com", "sessionid", "", encryptedCookie("PRIVATE_CLIENT_FIXTURE"), "/", 0n, 1);
  insert.run("unrelated.test", "PRIVATE_UNRELATED", "PRIVATE_OTHER_COOKIE", Buffer.alloc(0), "/", 0n, 1);
  insert.run(".doubao.com", "wrong_path", "PRIVATE_PATH_COOKIE", Buffer.alloc(0), "/accounts", 0n, 1);
  db.close();
  const before = await readFile(file), result = await readClientCookieRows(file);
  assert.equal(result.version, 24);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].name, "sessionid");
  assert.deepEqual(await readFile(file), before);
});

test("客户端登录：跳过过期和其他域，只导入 Work 账号且不改源文件", { skip: process.platform !== "win32" }, async (t) => {
  const root = await directory(t);
  await mkdir(join(root, "Default", "Network"), { recursive: true });
  const state = JSON.stringify({ os_crypt: { encrypted_key: Buffer.from("DPAPI_MASTER_FIXTURE").toString("base64") }, aha: { device: { device_id: "client_device" } } });
  await writeFile(join(root, "Local State"), state);
  await writeFile(join(root, "Default", "Network", "Cookies"), "fixture DB");
  let decrypted = 0;
  const sessions = await readClientSessions({ env: { DW_DOUBAO_WORK_PROFILE: root }, discover: async () => [],
    unprotect: async (value) => { decrypted++; assert.equal(value.toString(), "_MASTER_FIXTURE"); return key; },
    readRows: async () => ({ version: 24, rows: [
      { host_key: ".doubao.com", name: "sessionid", path: "/", expires_utc: 0n, encrypted_value: encryptedCookie("PRIVATE_CLIENT_FIXTURE") },
      { host_key: ".doubao.com", name: "expired", path: "/", expires_utc: 11644473600000001n, encrypted_value: Buffer.from("invalid") },
      { host_key: "other.test", name: "other", path: "/", expires_utc: 0n, encrypted_value: Buffer.from("invalid") },
    ] }),
  });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].profile, "Default");
  assert.equal(sessions[0].secret.deviceId, "client_device");
  assert.equal(sessions[0].secret.cookieHeader, "sessionid=PRIVATE_CLIENT_FIXTURE");
  assert.equal(decrypted, 1);
  assert.equal(await readFile(join(root, "Local State"), "utf8"), state);
  assert.equal(await readFile(join(root, "Default", "Network", "Cookies"), "utf8"), "fixture DB");
});

test("客户端导入：核验账号后保存，同账号去重，异常凭据不进入公开结果", async () => {
  const saved = [], events = [];
  const secret = { cookieHeader: "sessionid=PRIVATE_IMPORT_COOKIE", deviceId: "client_device" };
  const result = await importClientAccounts({
    store: { list: async () => { events.push("store"); return []; }, save: async (login) => { saved.push(login); return { uid: login.uid }; } },
    api: { identify: async (account) => { if (account.invalid) throw Error("PRIVATE_EXCEPTION_COOKIE"); return { ...account, userId: "client", name: "客户端账号" }; } },
    loadSessions: async () => { events.push("read"); return [{ profile: "Default", secret }, { profile: "Profile 3", secret }, { profile: "Profile 4", secret: { ...secret, invalid: true } }]; },
  });
  assert.deepEqual(events, ["store", "read"]);
  assert.deepEqual(result, { imported: 1, failed: 1 });
  assert.equal(saved.length, 1);
  assert.equal(readAuth({ type: "oauth", access: saved[0].access }).userId, "client");
  assert(!JSON.stringify(result).includes("PRIVATE"));
});

test("客户端版 CLI：配置与普通版隔离，导入使用客户端配置路径", async (t) => {
  const cwd = await directory(t), logs = [];
  await writeFile(join(cwd, ".env"), "DW_PORT=7777\nDW_API_KEY=ordinary\n");
  await writeFile(join(cwd, ".env.work-client"), "DW_DOUBAO_WORK_PROFILE=C:\\Client\\DoubaoWork\\User Data\nDW_DELETE_HISTORY=true\n");
  let root;
  await runCli({ argv: ["import-client"], cwd, env: {}, clientMode: true, signals: new EventEmitter(), io: { log: (text) => logs.push(text) },
    storeFactory: (value) => { root = value; return {}; }, clientImporter: async ({ env }) => {
      assert.equal(env.DW_DOUBAO_WORK_PROFILE, "C:\\Client\\DoubaoWork\\User Data");
      return { imported: 2, failed: 0 };
    },
  });
  assert.equal(root, join(cwd, "data-work-client"));
  assert(logs[0].includes("2 个账号"));
  const config = await loadConfig({ cwd, env: {}, envFile: ".env.work-client", defaults: { DW_PORT: "8789", DW_ADMIN_PORT: "8788", DW_DATA_DIR: "data-work-client" } });
  assert.equal(config.port, 8789);
  assert.equal(config.adminPort, 8788);
  assert.equal(config.apiKey, undefined);
  assert.equal(config.deleteHistory, true);
});

test("历史配置：兼容旧开关，新删除开关优先，非法值拒绝", async (t) => {
  const cwd = await directory(t);
  assert.equal((await loadConfig({ cwd, env: { DW_HIDE_HISTORY: "false" } })).deleteHistory, false);
  assert.equal((await loadConfig({ cwd, env: { DW_HIDE_HISTORY: "false", DW_DELETE_HISTORY: "true" } })).deleteHistory, true);
  await assert.rejects(loadConfig({ cwd, env: { DW_DELETE_HISTORY: "yes" } }));
});
