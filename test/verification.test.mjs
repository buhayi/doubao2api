// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve, basename } from "node:path";
import { createVerificationManager, withAutomaticVerification } from "../verification.mjs";
import { createStore } from "../gateway/store.mjs";
import { createCompletion } from "../completion.mjs";
import { credentials, vendorError, verificationDecision, saveAuth } from "../protocol.mjs";

const secret = (userId = "a", session = "OLD") => credentials({ cookieHeader: "sessionid=" + session + "; s_v_web_id=OLD_FP", userId, enterpriseType: "0", deviceId: "REAL_DEVICE", webId: "REAL_WEB" });
const decision = { type: "verify", subtype: "slide", challenge: "PRIVATE_CHALLENGE" };
const rejection = () => vendorError(429, { code: 710022004, extra: { decision } });
const frame = (event, data) => "event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n";
const verificationFrame = frame("SSE_ERROR", { code: 710022004, extra: { decision } });
const model = { id: "flash", name: "Flash", agentMode: 2, modeId: "3", deepThink: 4, extra: {} };
const body = { model: "flash", messages: [{ role: "user", content: "fixture" }], stream: true };
const catalog = async () => ({ bot: "BOT", models: { flash: model } });

async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), "dw-verification-test-"));
  assert.equal(dirname(root), resolve(tmpdir()));
  assert(basename(root).startsWith("dw-verification-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("验证 decision 只在内部保存，不出现在公开错误和日志字段中", () => {
  const error = rejection();
  assert.deepEqual(verificationDecision(error), decision);
  assert(!JSON.stringify(error).includes("PRIVATE_CHALLENGE"));
  assert(!error.message.includes("PRIVATE_CHALLENGE"));
  const rate = vendorError(429, { code: 710022004 });
  assert.equal(verificationDecision(rate), undefined);
  assert.equal(rate.reason, "rate_limited");
});

test("旧恢复入口停用：启用旧选项也不打开窗口或修改账号", async (t) => {
  const root = await directory(t);
  let discoveries = 0, launches = 0, identifies = 0, refreshes = 0, notices = 0;
  const manager = createVerificationManager({
    root, enabled: true, autoEnabled: true, manualFallback: true,
    discover: async () => { discoveries++; return [{ id: "edge" }]; },
    launch: async () => { launches++; throw Error("不能打开验证窗口"); },
    api: { identify: async () => { identifies++; } },
    store: { refreshSession: async () => { refreshes++; } },
  });
  for (const error of [rejection(), vendorError(401), vendorError(429)])
    await assert.rejects(manager.recover(secret(), error, { onVerification: () => { notices++; } }), (cause) => cause === error);
  await manager.dispose();
  assert.deepEqual([discoveries, launches, identifies, refreshes, notices], [0, 0, 0, 0, 0]);
  assert.deepEqual(await readdir(root), []);
  assert.equal(manager.status().mode, "disabled");
  assert.equal(manager.status().enabled, false);
});

test("旧 API 包装入口保留原 API，验证失败不重试或更换会话", async () => {
  let posts = 0, recoveries = 0;
  const account = secret(), error = rejection();
  const raw = { post: async (current) => { posts++; assert.equal(current, account); throw error; } };
  const api = withAutomaticVerification(raw, { recover: async () => { recoveries++; return secret("a", "NEW"); } });
  assert.equal(api, raw);
  await assert.rejects(api.post(account, "/chat/completion", {}), (cause) => cause === error);
  assert.equal(posts, 1);
  assert.equal(recoveries, 0);
});

test("对话中的 HTTP 与 SSE 验证错误直接返回，清理会话且不调用旧恢复钩子", async (t) => {
  for (const transport of ["http", "sse"]) for (const stream of [true, false])
    await t.test(transport + " stream=" + stream, async () => {
      let posts = 0, recoveries = 0, cleanups = 0;
      const error = rejection();
      const api = {
        catalog,
        post: async (current, _path, _payload, options) => {
          posts++; assert.equal(current.userId, "a"); assert.equal(options.onVerification, undefined);
          if (transport === "http") throw error;
          return new Response(verificationFrame);
        },
        recover: async () => { recoveries++; return secret("a", "NEW"); },
      };
      await assert.rejects(createCompletion(api, secret(), { ...body, stream }, {
        onVerification: () => { throw Error("不能要求人工验证"); },
        cleanupConversation: async () => { cleanups++; },
      }), (cause) => cause.reason === "verification_required");
      assert.equal(posts, 1);
      assert.equal(recoveries, 0);
      assert.equal(cleanups, 1);
    });
});

test("SSE 已收到会话或文本时，验证失败仍不重发请求", async (t) => {
  for (const prefix of [
    frame("SSE_ACK", { ack_client_meta: { conversation_id: "accepted" } }),
    frame("FULL_MSG_NOTIFY", { message: { user_type: 1, conversation_id: "created" } }),
    frame("CHUNK_DELTA", { text: "partial" }),
  ]) await t.test(prefix.split("\n")[0], async () => {
    let posts = 0, recoveries = 0;
    const api = { catalog, post: async () => { posts++; return new Response(prefix + verificationFrame); }, recover: async () => { recoveries++; return secret(); } };
    await assert.rejects(async () => { const response = await createCompletion(api, secret(), body); await response.text(); }, (error) => error.reason === "verification_required");
    assert.equal(posts, 1);
    assert.equal(recoveries, 0);
  });
});

test("会话刷新保留账号名称、启停与默认选择，并拒绝覆盖并发重新登录", async (t) => {
  const root = await directory(t);
  const store = createStore(root, { secureRoot: (path) => mkdir(path, { recursive: true }) });
  await store.save(saveAuth(secret("a")));
  await store.save(saveAuth(secret("b", "OTHER")));
  await store.update("a:0", { name: "用户自定义名称", enabled: false });
  await store.refreshSession("a:0", secret("a", "REFRESHED"), { expectedCookieHeader: secret().cookieHeader });
  const list = await store.list();
  assert.equal(list[0].name, "用户自定义名称");
  assert.equal(list[0].enabled, false);
  assert.equal(list[1].default, true);
  assert.equal((await store.account("a:0", { allowDisabled: true })).secret.cookieHeader, secret("a", "REFRESHED").cookieHeader);
  await store.save(saveAuth(secret("a", "RELOGIN")));
  await assert.rejects(store.refreshSession("a:0", secret("a", "LATE"), { expectedCookieHeader: secret("a", "REFRESHED").cookieHeader }), (e) => e.status === 409);
  assert.equal((await store.account("a:0", { allowDisabled: true })).secret.cookieHeader, secret("a", "RELOGIN").cookieHeader);
});

