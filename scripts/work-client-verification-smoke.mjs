// SPDX-License-Identifier: AGPL-3.0-only
// A local fixture triggers the real window helper without calling Doubao's API.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { activateWorkClient, createClientVerificationManager } from "../desktop/verification.mjs";
import { loadConfig } from "../gateway/config.mjs";
import { createGateway } from "../gateway/server.mjs";
import { vendorError } from "../protocol.mjs";

if (process.platform !== "win32") throw Error("窗口唤起测试仅支持 Windows。");
if (process.argv.slice(2).some((arg) => arg !== "--sse")) throw Error("此测试仅支持 --sse 选项。");

const transport = process.argv.includes("--sse") ? "sse" : "http";
const config = await loadConfig({ envFile: ".env.work-client" });
const decision = { code: 710022004, extra: { decision: { type: "verify" } } };
const apiKey = randomUUID();
let activation, requests = 0;
const verification = createClientVerificationManager({
  env: { ...process.env, ...config.clientPaths }, notify() {},
  activate: async (options) => { activation = await activateWorkClient(options); return activation; },
});
const service = createGateway({
  apiKey, edition: "work-client", clientVerification: verification,
  heartbeatMs: 0, timeoutMs: 30000, deleteHistory: false,
  store: { account: async () => ({ uid: "window-smoke", secret: { userId: "window-smoke", enterpriseType: "0" } }) },
  api: {
    catalog: async () => ({ bot: "window-smoke", models: { smoke: { id: "smoke", agentMode: 2, modeId: "3", extra: {} } } }),
    post: async () => {
      requests++;
      if (transport === "http") throw vendorError(429, decision);
      return new Response(`event: SSE_ERROR\ndata: ${JSON.stringify(decision)}\n\n`);
    },
  },
});
try {
  service.server.listen(0, "127.0.0.1");
  await once(service.server, "listening");
  const response = await fetch(`http://127.0.0.1:${service.server.address().port}/v1/chat/completions`, {
    method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "smoke", messages: [{ role: "user", content: "window-smoke" }], stream: false }),
  });
  const result = await response.json();
  assert.equal(response.status, 429);
  assert.equal(result.error.code, "verification_required");
  assert.equal(requests, 1);
  assert.equal(activation?.state, "foreground", "客户端未置前；请检查安装路径或 Windows 窗口状态。");
  console.log(`${transport.toUpperCase()} 模拟验证拒绝已将豆包工作弹到前台（${activation.launched ? "启动客户端" : "恢复已有窗口"}）。`);
} finally {
  await service.close();
  await verification.dispose();
}
