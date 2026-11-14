// SPDX-License-Identifier: AGPL-3.0-only
// Real Node/Bun browser handshake, headless blank page, no account or public URL.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { availableBrowsers, launchIsolatedBrowser } from "../browser-login.mjs";
import { protectWindowsProfile } from "../windows-browser.mjs";

const transport = process.argv[2] || "pipe";
assert(["pipe", "port"].includes(transport), "Transport must be pipe or port");
const browser = (await availableBrowsers()).find((choice) => ["chrome", "edge", "chromium"].includes(choice.id));
if (!browser) { console.log("SKIP: no Chrome / Edge / Chromium installed"); process.exit(0); }
const profile = await mkdtemp(join(tmpdir(), "dw-gateway-browser-smoke-"));
assert.equal(dirname(profile), resolve(tmpdir()));
assert(basename(profile).startsWith("dw-gateway-browser-smoke-"));
let handle;
try {
  if (process.platform === "win32") await protectWindowsProfile(profile);
  else await chmod(profile, 0o700);
  console.log(`Checking ${process.versions.bun ? "Bun" : "Node"} ${process.platform} ${browser.name} ${transport} (headless blank private profile)`);
  handle = await launchIsolatedBrowser(browser, profile, {
    blank: true, transport,
    spawnProcess: (file, args, options) => spawn(file, ["--headless=new", ...args], { ...options, windowsHide: true }),
  });
  assert.deepEqual(await handle.cookies(), []);
  assert.deepEqual(await handle.identity(), {});
  console.log("PASS: isolated handshake, no cookies, no page identity");
} finally {
  await handle?.dispose();
  await rm(profile, { recursive: true, force: true, maxRetries: 6, retryDelay: 300 });
}
console.log("PASS: browser closed and dedicated temporary profile removed");
