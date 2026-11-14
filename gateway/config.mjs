// SPDX-License-Identifier: AGPL-3.0-only
import { readFile } from "node:fs/promises";
import { resolve, relative, isAbsolute, parse, sep } from "node:path";
import { parseEnv } from "node:util";
import { isIP } from "node:net";

export function validateApiKey(key) {
  // HTTP clients trim outer whitespace and cannot reliably send Unicode header values.
  // Allow short keys, punctuation and internal spaces, without a prefix or length policy.
  if (typeof key !== "string" || !key || /[^\x20-\x7e]/.test(key) || key.trim() !== key)
    throw Error("DW_API_KEY 必须是非空可打印 ASCII 字符串，不能包含首尾空格或换行。");
  return key;
}
function integer(value, fallback, min, max, name) {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(String(value)) || Number(value) < min || Number(value) > max)
    throw Error(`${name} 必须是 ${min}–${max} 之间的整数。`);
  return Number(value);
}
export async function loadConfig({ cwd = process.cwd(), env = process.env } = {}) {
  let local = {};
  try { local = parseEnv(await readFile(resolve(cwd, ".env"), "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const values = { ...local, ...env };
  const host = values.DW_HOST || "127.0.0.1";
  if (!isIP(host) && !/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(host))
    throw Error("DW_HOST 必须是 IP 地址或主机名，不包含协议或端口。");
  const corsOrigins = (values.DW_CORS_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const origin of corsOrigins) {
    if (origin === "*") continue;
    let url;
    try { url = new URL(origin); } catch { throw Error("DW_CORS_ORIGINS 中有无效的来源地址。"); }
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin)
      throw Error("DW_CORS_ORIGINS 只接受不含路径的 HTTP(S) 来源地址。");
  }
  for (const name of ["DW_PROMPT_TOOLS", "DW_HIDE_HISTORY"])
    if (values[name] !== undefined && !["true", "false"].includes(values[name]))
      throw Error(`${name} 必须为 true 或 false。`);
  const dataDir = resolve(cwd, values.DW_DATA_DIR || "data");
  const inside = relative(dataDir, resolve(cwd));
  if (dataDir === parse(dataDir).root || inside === "" || (!isAbsolute(inside) && inside !== ".." && !inside.startsWith(".." + sep)))
    throw Error("DW_DATA_DIR 必须是专用数据目录，不能指向项目目录、其父目录或磁盘根目录。");
  const port = integer(values.DW_PORT, 8787, 1, 65535, "DW_PORT");
  const adminPort = integer(values.DW_ADMIN_PORT, 8786, 0, 65535, "DW_ADMIN_PORT");
  if (adminPort && adminPort === port) throw Error("DW_ADMIN_PORT 不能与 DW_PORT 使用同一个端口。");
  return {
    host,
    port,
    adminPort,
    dataDir,
    apiKey: values.DW_API_KEY ? validateApiKey(values.DW_API_KEY) : undefined,
    accountId: values.DW_ACCOUNT_ID || undefined,
    corsOrigins,
    promptTools: values.DW_PROMPT_TOOLS !== "false",
    hideHistory: values.DW_HIDE_HISTORY !== "false",
    timeoutMs: integer(values.DW_TIMEOUT_MS, 120000, 1000, 600000, "DW_TIMEOUT_MS"),
    maxConcurrency: integer(values.DW_MAX_CONCURRENCY, 3, 1, 16, "DW_MAX_CONCURRENCY"),
  };
}
export function baseUrl(host, port) {
  const address = ["0.0.0.0", "::"].includes(host) ? "127.0.0.1" : host;
  return `http://${isIP(address) === 6 ? `[${address}]` : address}:${port}/v1`;
}
