// SPDX-License-Identifier: AGPL-3.0-only
import { readFile, writeFile, readdir, mkdir, chmod, lstat, open, rename, unlink } from "node:fs/promises";
import { join, resolve, parse } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { readAuth, saveAuth, fail } from "../protocol.mjs";
import { protectWindowsProfile } from "../windows-browser.mjs";
import { validateApiKey } from "./config.mjs";

async function protectRoot(root) {
  if (root === parse(root).root) throw Error("不能将磁盘根目录作为私有数据目录。");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw Error("数据目录必须是独立的真实目录，不能是符号链接。");
  const entries = await readdir(root);
  if (entries.some((name) => ![".gitignore", "config.json", "accounts.json", "config.lock", "accounts.lock", "tmp", "checkins"].includes(name) && !/^(?:config|accounts)\.json\.[a-f0-9-]{36}\.tmp$/.test(name)))
    throw Error("数据目录含有其他文件；请使用网关专用目录，不会修改现有目录权限。");
  // Keep accepting private records left by older versions after removing check-in.
  if (entries.includes("checkins")) {
    const checkins = await lstat(join(root, "checkins"));
    if (!checkins.isDirectory() || checkins.isSymbolicLink()) throw Error("签到记录必须保存在真实的专用目录中，不能使用文件或符号链接。");
  }
  if (process.platform === "win32") await protectWindowsProfile(root);
  else await chmod(root, 0o700);
  try { await writeFile(join(root, ".gitignore"), "*\n!.gitignore\n", { flag: "wx", mode: 0o600 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
}
async function readJson(file, fallback) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024)
      throw Error("Invalid state file");
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw Error("网关本地数据损坏或不可读取；请检查数据目录，不会覆盖现有凭据。");
  }
}
async function atomicJson(file, value) {
  const encoded = JSON.stringify(value, null, 2) + "\n";
  if (Buffer.byteLength(encoded) > 2 * 1024 * 1024) throw fail(413, "本地账号数据超过 2 MiB 限制，请移除不再使用的账号后重试。");
  const temporary = file + "." + randomUUID() + ".tmp";
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(encoded);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, file);
  } finally {
    await handle?.close();
    await unlink(temporary).catch((e) => { if (e.code !== "ENOENT") throw e; });
  }
}
function accountFromLogin(result) {
  if (result?.type !== "success") throw fail(400, "只能保存经过核验的登录结果。");
  const auth = { type: "oauth", access: result.access, refresh: "", expires: 0 };
  const secret = readAuth(auth);
  const uid = secret.userId + ":" + (secret.enterpriseType || "0");
  if (result.uid !== uid) throw fail(400, "登录结果的账号标识不一致。");
  return { uid, name: secret.name || secret.userId, auth, updatedAt: Date.now() };
}
function validateAccounts(state) {
  try {
    if (state?.version !== 1 || !Array.isArray(state.accounts) || state.accounts.length > 64) throw Error();
    const seen = new Set();
    for (const account of state.accounts) {
      const secret = readAuth(account?.auth);
      if (account.uid !== secret.userId + ":" + (secret.enterpriseType || "0") || seen.has(account.uid)) throw Error();
      if (typeof account.name !== "string" || !Number.isSafeInteger(account.updatedAt)) throw Error();
      if (account.enabled !== undefined && typeof account.enabled !== "boolean") throw Error();
      seen.add(account.uid);
    }
    if (state.defaultUid !== null && !seen.has(state.defaultUid)) throw Error();
    return state;
  } catch { throw Error("账号文件格式异常；请检查 accounts.json，不会自动重置或覆盖账号。"); }
}
export function createStore(directory, { secureRoot = protectRoot } = {}) {
  const root = resolve(directory);
  const accountsFile = join(root, "accounts.json");
  let initialization;
  const ready = () => initialization ??= Promise.resolve().then(() => secureRoot(root));
  const load = async () => {
    await ready();
    return validateAccounts(await readJson(accountsFile, { version: 1, defaultUid: null, accounts: [] }));
  };
  async function mutate(change) {
    await ready();
    const lock = join(root, "accounts.lock");
    let handle;
    try { handle = await open(lock, "wx", 0o600); }
    catch (error) {
      if (error.code === "EEXIST") throw fail(409, "另一个进程正在修改账号；请稍后重试。异常退出留下的 accounts.lock 请在停止所有账号管理命令后删除。");
      throw error;
    }
    try {
      await handle.writeFile(String(process.pid));
      const state = await load();
      const result = change(state);
      validateAccounts(state);
      await atomicJson(accountsFile, state);
      return result;
    } finally { await handle.close(); await unlink(lock); }
  }
  return {
    root,
    async apiKey(override) {
      await ready();
      if (override !== undefined) return validateApiKey(override);
      const file = join(root, "config.json");
      const old = await readJson(file, undefined);
      if (old !== undefined) {
        if (old?.version !== 1) throw Error("网关密钥文件版本不支持。");
        return validateApiKey(old.apiKey);
      }
      // Serialize first-run generation: another process must never observe a partial key file.
      const lock = join(root, "config.lock");
      let handle;
      try { handle = await open(lock, "wx", 0o600); }
      catch (error) {
        if (error.code === "EEXIST") throw fail(409, "另一进程正在初始化网关密钥，请稍后重试。");
        throw error;
      }
      try {
        const existing = await readJson(file, undefined);
        if (existing !== undefined) {
          if (existing?.version !== 1) throw Error("网关密钥文件版本不支持。");
          return validateApiKey(existing.apiKey);
        }
        const apiKey = "sk-dw-" + randomBytes(32).toString("hex");
        await atomicJson(file, { version: 1, apiKey });
        return apiKey;
      } finally { await handle.close(); await unlink(lock); }
    },
    async list() {
      const state = await load();
      return state.accounts.map(({ uid, name, updatedAt, enabled }) => ({ uid, name, updatedAt, enabled: enabled !== false, default: uid === state.defaultUid }));
    },
    async account(uid, { allowDisabled = false } = {}) {
      const state = await load();
      const account = state.accounts.find((a) => a.uid === (uid || state.defaultUid));
      if (!account) throw fail(503, uid ? "指定的网关账号不存在，请检查 DW_ACCOUNT_ID。" : state.accounts.length ? "所有账号已停用，请先在管理台启用一个账号。" : "还没有登录账号，请先在管理台添加账号或运行 npm run login。");
      if (account.enabled === false && !allowDisabled) throw fail(503, "指定的网关账号已停用，请先在管理台启用该账号。");
      return { ...account, secret: readAuth(account.auth) };
    },
    async save(result) {
      const account = accountFromLogin(result);
      return mutate((state) => {
        const index = state.accounts.findIndex((a) => a.uid === account.uid);
        if (index < 0) {
          if (state.accounts.length >= 64) throw fail(409, "账号池已达到 64 个账号上限，请先移除不再使用的账号。");
          state.accounts.push(account);
        } else state.accounts[index] = { ...account, enabled: state.accounts[index].enabled !== false };
        const saved = state.accounts.find((a) => a.uid === account.uid);
        if (saved.enabled !== false) state.defaultUid ??= account.uid;
        return { uid: account.uid, name: account.name, updated: index >= 0 };
      });
    },
    async refreshSession(uid, secret, { expectedCookieHeader } = {}) {
      const account = accountFromLogin(saveAuth(secret));
      if (account.uid !== uid) throw fail(409, "验证结果与当前账号不一致。");
      return mutate((state) => {
        const current = state.accounts.find((item) => item.uid === uid);
        if (!current) throw fail(409, "账号已移除，验证结果未保存。");
        if (readAuth(current.auth).cookieHeader !== expectedCookieHeader) throw fail(409, "账号会话已更新，验证结果未覆盖当前会话。");
        current.auth = account.auth;
        current.updatedAt = account.updatedAt;
        return { uid: current.uid, updatedAt: current.updatedAt };
      });
    },
    async use(uid) {
      return mutate((state) => {
        const account = state.accounts.find((a) => a.uid === uid);
        if (!account) throw fail(404, "这个账号不存在，请先查看账号列表。");
        if (account.enabled === false) throw fail(409, "请先启用账号，再设为默认账号。");
        state.defaultUid = uid;
      });
    },
    async update(uid, changes) {
      if (!changes || typeof changes !== "object" || Array.isArray(changes) || !Object.keys(changes).length || Object.keys(changes).some((key) => !["name", "enabled"].includes(key)))
        throw fail(400, "只支持修改账号名称或启用状态。");
      if (changes.name !== undefined && (typeof changes.name !== "string" || !changes.name.trim() || changes.name.trim().length > 80 || /[\u0000-\u001f\u007f]/.test(changes.name)))
        throw fail(400, "账号名称须为 1–80 个字符，不能包含控制字符。");
      if (changes.enabled !== undefined && typeof changes.enabled !== "boolean") throw fail(400, "enabled 必须是布尔值。");
      return mutate((state) => {
        const account = state.accounts.find((a) => a.uid === uid);
        if (!account) throw fail(404, "这个账号不存在。");
        if (changes.name !== undefined) account.name = changes.name.trim();
        if (changes.enabled !== undefined) account.enabled = changes.enabled;
        if (account.enabled === false && state.defaultUid === uid)
          state.defaultUid = state.accounts.find((a) => a.enabled !== false)?.uid ?? null;
        if (account.enabled !== false) state.defaultUid ??= uid;
      });
    },
    async remove(uid) {
      return mutate((state) => {
        const index = state.accounts.findIndex((a) => a.uid === uid);
        if (index < 0) throw fail(404, "这个账号不存在。");
        state.accounts.splice(index, 1);
        if (state.defaultUid === uid) state.defaultUid = state.accounts.find((a) => a.enabled !== false)?.uid ?? null;
      });
    },
  };
}
