// SPDX-License-Identifier: AGPL-3.0-only
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, dirname, win32 } from "node:path";
import { homedir } from "node:os";
import { credentials, saveAuth, fail } from "../protocol.mjs";
import { availableBrowsers, sessionIdentity } from "../browser-login.mjs";
import { envValue } from "../windows-browser.mjs";

const exec = promisify(execFile);
const domains = new Set(["doubao.com", ".doubao.com", "www.doubao.com", ".www.doubao.com"]);
const epoch = 11644473600000000n;
const unprotectScript = String.raw`
$ErrorActionPreference = 'Stop'
$PSModuleAutoLoadingPreference = 'None'
try {
  [void][Reflection.Assembly]::LoadWithPartialName('System.Security')
  $inputValue = [Console]::In.ReadLine()
  $encrypted = [Convert]::FromBase64String($inputValue)
  $plain = [Security.Cryptography.ProtectedData]::Unprotect($encrypted,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Console]::WriteLine([Convert]::ToBase64String($plain))
} catch { exit 1 }
`;

// Only the currently logged-in Windows user's DPAPI is used. Secret input goes
// through stdin, never through command arguments, environment values or logs.
export async function unprotectWindows(value, { env = process.env, signal } = {}) {
  if (process.platform !== "win32") throw fail(400, "客户端登录导入仅支持 Windows。");
  try {
    const file = win32.join(envValue(env, "SystemRoot") || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const task = exec(file, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(unprotectScript, "utf16le").toString("base64")], {
      shell: false, windowsHide: true, timeout: 10000, maxBuffer: 4 * 1024 * 1024, encoding: "utf8", signal,
    });
    task.child.stdin.on("error", () => {});
    task.child.stdin.end(Buffer.from(value).toString("base64") + "\n");
    const { stdout } = await task;
    const encoded = stdout.trim();
    if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw Error();
    return Buffer.from(encoded, "base64");
  } catch {
    if (signal?.aborted) throw signal.reason;
    throw fail(401, "无法解密客户端登录，请以登录豆包工作的同一 Windows 用户运行。");
  }
}

export async function decryptClientCookie(value, { key, host, hostBound = false, unprotect = unprotectWindows, signal } = {}) {
  const encrypted = Buffer.from(value);
  const format = encrypted.subarray(0, 3).toString("ascii");
  let plain;
  try {
    if (["v10", "v11"].includes(format)) {
      if (!Buffer.isBuffer(key) || key.length !== 32 || encrypted.length < 31) throw Error();
      const cipher = createDecipheriv("aes-256-gcm", key, encrypted.subarray(3, 15));
      cipher.setAuthTag(encrypted.subarray(-16));
      plain = Buffer.concat([cipher.update(encrypted.subarray(15, -16)), cipher.final()]);
    } else if (format === "v20") {
      throw fail(409, "客户端使用应用绑定加密，请运行 npm run login:work-client 在豆包工作独立窗口中登录。");
    } else {
      plain = Buffer.from(await unprotect(encrypted, { signal }));
    }
    if (hostBound) {
      const expected = createHash("sha256").update(host).digest();
      if (plain.length < 32 || !timingSafeEqual(plain.subarray(0, 32), expected)) throw Error();
      plain = plain.subarray(32);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(plain);
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (error.status) throw error;
    throw fail(401, "客户端登录解密或域校验失败，请在豆包工作客户端重新登录后再导入。");
  }
}

async function boundedFile(path, maxBytes) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) throw fail(400, "客户端登录文件格式异常。");
  return path;
}

export async function readClientCookieRows(path) {
  await boundedFile(path, 64 * 1024 * 1024);
  let DatabaseSync;
  try { ({ DatabaseSync } = await import("node:sqlite")); }
  catch { throw fail(503, "客户端登录导入需要 Node.js 22.13 或更新版本。"); }
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.exec("PRAGMA query_only = ON; BEGIN");
    const version = Number(db.prepare("SELECT value FROM meta WHERE key = ?").get("version")?.value || 0);
    const query = db.prepare("SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure FROM cookies WHERE host_key IN (?, ?, ?, ?) AND path = ?");
    query.setReadBigInts(true);
    const rows = query.all(...domains, "/");
    db.exec("COMMIT");
    return { version, rows };
  } catch {
    throw fail(409, "客户端登录库暂不可读取，请先完全退出豆包工作客户端后重试。");
  } finally { db?.close(); }
}

// Read only Doubao Work's profile; do not launch the daily client, alter its
// database, copy its browsing data or open a debugging listener.
export async function readClientSessions({
  platform = process.platform, home = homedir(), env = process.env, signal,
  readRows = readClientCookieRows, unprotect = unprotectWindows, discover = availableBrowsers,
  now = Date.now(),
} = {}) {
  if (platform !== "win32") throw fail(400, "豆包工作客户端版仅支持 Windows。");
  const raw = envValue(env, "DW_DOUBAO_WORK_PROFILE") || win32.join(envValue(env, "LOCALAPPDATA") || win32.join(home, "AppData", "Local"), "DoubaoWork", "User Data");
  if (!/^[a-z]:[\\/]/i.test(raw) || /[<>"|?*\x00-\x1f]/.test(raw)) throw fail(400, "DW_DOUBAO_WORK_PROFILE 必须是本机绝对目录。");
  const root = win32.normalize(raw);
  let state, profiles;
  try {
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw Error();
    state = JSON.parse(await readFile(await boundedFile(join(root, "Local State"), 8 * 1024 * 1024), "utf8"));
    profiles = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory() && /^(?:Default|Profile [0-9]+)$/.test(entry.name));
  } catch {
    throw fail(404, "未找到豆包工作登录目录，请先安装并登录 Windows 豆包工作客户端。");
  }
  if (profiles.length > 64) throw fail(413, "客户端账号数量超过 64 个导入限制。");
  const identity = sessionIdentity({ deviceId: state?.aha?.device?.device_id });
  const client = (await discover(platform, home, env)).find((browser) => browser.id === "doubaowork");
  if (client) {
    try {
      const manifest = JSON.parse(await readFile(await boundedFile(join(dirname(client.path), "manifest.json"), 1024 * 1024), "utf8"));
      Object.assign(identity, sessionIdentity({ clientVersion: manifest.version, channel: manifest.channel }));
    } catch { /* The verified session can still work without optional version metadata. */ }
  }
  let key;
  const master = async () => {
    if (key) return key;
    const encoded = state?.os_crypt?.encrypted_key;
    if (typeof encoded !== "string" || encoded.length > 16384) throw fail(401, "客户端登录密钥不完整，请重新登录豆包工作客户端。");
    const encrypted = Buffer.from(encoded, "base64");
    if (encrypted.subarray(0, 5).toString("ascii") !== "DPAPI") throw fail(409, "客户端登录密钥格式不支持，请运行 npm run login:work-client 登录。");
    key = Buffer.from(await unprotect(encrypted.subarray(5), { signal, env }));
    if (key.length !== 32) throw fail(401, "客户端登录密钥格式异常。");
    return key;
  };
  const sessions = [];
  try {
    for (const profile of profiles.sort((a, b) => a.name.localeCompare(b.name))) {
      if (signal?.aborted) throw signal.reason;
      let file = join(root, profile.name, "Network", "Cookies");
      try { await lstat(file); }
      catch (error) { if (error.code !== "ENOENT") throw error; file = join(root, profile.name, "Cookies"); }
      let data;
      try { data = await readRows(file); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      const cookies = [];
      for (const row of data.rows) {
        if (!domains.has(row.host_key) || row.path !== "/") continue;
        const expires = BigInt(row.expires_utc || 0);
        if (expires && expires <= epoch + BigInt(Math.floor(now)) * 1000n) continue;
        let value = row.value;
        if (!value && row.encrypted_value?.length) {
          const encrypted = Buffer.from(row.encrypted_value);
          value = await decryptClientCookie(encrypted, {
            key: ["v10", "v11"].includes(encrypted.subarray(0, 3).toString("ascii")) ? await master() : undefined,
            host: row.host_key, hostBound: data.version >= 24, unprotect, signal,
          });
        }
        if (value) cookies.push({ name: row.name, value, domain: row.host_key, path: "/", expires: expires ? Number((expires - epoch) / 1000000n) : -1 });
      }
      if (!cookies.some((cookie) => ["sessionid", "sessionid_ss"].includes(cookie.name))) continue;
      const secret = credentials({ cookies, ...identity });
      sessions.push({ profile: profile.name, secret });
    }
  } finally { key?.fill(0); }
  if (!sessions.length) throw fail(401, "没有找到有效的豆包工作登录，请先在客户端登录，再运行 npm run import:work-client。");
  return sessions;
}

export async function importClientAccounts({ store, api, signal, env, loadSessions = readClientSessions, onVerification } = {}) {
  await store.list(); // Initialize the gateway's private store before reading credentials.
  const sessions = await loadSessions({ signal, env });
  const imported = [], failed = [], seen = new Set();
  for (const { profile, secret } of sessions) {
    if (signal?.aborted) throw signal.reason;
    try {
      const verified = await api.identify(secret, { signal });
      const login = saveAuth(verified);
      if (seen.has(login.uid)) continue;
      seen.add(login.uid);
      imported.push(await store.save(login));
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error?.reason === "verification_required") await onVerification?.({ uid: `client:${profile}`, name: `客户端账号（${profile}）` }, error, { signal });
      failed.push({ profile, message: "客户端账号核验失败，请重新登录客户端后再导入。" });
    }
  }
  if (!imported.length) throw fail(401, "客户端账号核验未通过，请重新登录豆包工作客户端后再导入。");
  return { imported: imported.length, failed: failed.length };
}
