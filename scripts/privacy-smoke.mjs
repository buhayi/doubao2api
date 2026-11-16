// SPDX-License-Identifier: AGPL-3.0-only
// One real short reply, then delete and read back only this test conversation.
// A failed cleanup keeps its ID in the existing private account directory.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createApi } from "../protocol.mjs";
import { createCompletion } from "../completion.mjs";
import { createHistoryCleaner } from "../gateway/history.mjs";
import { createStore } from "../gateway/store.mjs";
import { loadConfig } from "../gateway/config.mjs";

const client = process.argv.includes("--client");
const cleanupOnly = process.argv.includes("--cleanup-pending");
const inspectOnly = process.argv.includes("--inspect-pending");
const config = await loadConfig({ ...(client ? {
  envFile: ".env.work-client", defaults: { DW_PORT: "8789", DW_ADMIN_PORT: "8788", DW_DATA_DIR: "data-work-client" },
} : {}) });
const store = createStore(config.dataDir), api = createApi();
const pendingFile = join(store.root, "tmp", "privacy-smoke-pending.json");
let pending;
try { pending = JSON.parse(await readFile(pendingFile, "utf8")); }
catch (error) { if (error.code !== "ENOENT") throw Error("Pending cleanup state is unreadable."); }
if (pending && !cleanupOnly && !inspectOnly) throw Error("Clean the pending smoke conversation before creating another.");
if ((cleanupOnly || inspectOnly) && !pending) throw Error("No pending smoke conversation.");
if (inspectOnly) {
  const account = await store.account(pending.uid);
  const value = await api.post(account.secret, "/im/conversation/batch_get", {
    cmd: 1111, sequence_id: randomUUID(), channel: 2, version: "1",
    uplink_body: { batch_get_conv_info_uplink_body: {
      conversation_id: [pending.conversation.conversationId], option: { recent_message_count_per_conv: 0 }, ext: {},
    } },
  });
  const entries = value.downlink_body?.batch_get_conv_info_downlink_body?.conversation_info_list;
  console.log(JSON.stringify({ result: "INSPECT", count: entries?.length,
    statuses: entries?.map((entry) => entry.status) }));
  process.exit();
}
let invisible = false, observed, upstreamFailure;
const tracked = { ...api, post: (secret, path, payload, options) => {
  if (path === "/chat/completion") invisible = payload.messages.every((message) => message.message_status === 1);
  assert(!path.endsWith("/archive"), "An archive action cannot satisfy this check.");
  return api.post(secret, path, payload, options).catch((error) => {
    upstreamFailure = { status: error.status, reason: error.reason, code: error.upstreamCode,
      message: error.status ? error.message : undefined };
    throw error;
  });
} };
const history = createHistoryCleaner({ api: tracked });
try {
  const account = await store.account(pending?.uid || config.accountId);
  const cleanup = async (conversation) => {
    observed = conversation;
    if (conversation.conversationId) {
      await mkdir(join(store.root, "tmp"), { recursive: true, mode: 0o700 });
      await writeFile(pendingFile, JSON.stringify({ uid: account.uid, conversation }), { mode: 0o600 });
    }
    return history.clean(account.secret, conversation);
  };
  if (cleanupOnly) await cleanup(pending.conversation);
  else {
    const catalog = await api.catalog(account.secret);
    const entries = Object.entries(catalog.models);
    const selected = entries.find(([id, model]) => /flash|lite|快速/i.test(id + " " + model.name)) || entries[0];
    assert(selected, "No available model.");
    const response = await createCompletion(tracked, account.secret, {
      model: selected[0], messages: [{ role: "user", content: "只回复 OK" }], stream: false,
    }, { signal: AbortSignal.timeout(120000), promptTools: false, cleanupConversation: cleanup });
    const reply = await response.json();
    assert(reply.choices[0].message.content?.trim(), "Missing reply.");
    assert(invisible, "The sent text was not invisible.");
  }
  assert.equal(history.status().deleted, 1, "The test conversation was not deleted.");
  const info = await api.post(account.secret, "/im/conversation/batch_get", {
    cmd: 1111, sequence_id: randomUUID(), channel: 2, version: "1",
    uplink_body: { batch_get_conv_info_uplink_body: {
      conversation_id: [observed.conversationId], option: { recent_message_count_per_conv: 0 }, ext: {},
    } },
  });
  assert.equal(Number(info.status_code), 0, "Conversation lookup failed.");
  const conversations = info.downlink_body?.batch_get_conv_info_downlink_body?.conversation_info_list;
  assert(Array.isArray(conversations), "Unexpected conversation lookup result.");
  // The installed client defines DELETED=2 and ARCHIVE=8. IM may return a
  // deleted tombstone instead of omitting the conversation from batch_get.
  assert(conversations.length === 0 || (conversations.length === 1
    && conversations[0].conversation_id === observed.conversationId
    && Number(conversations[0].status) === 2), "The test conversation is not marked deleted.");
  await unlink(pendingFile);
  console.log(JSON.stringify({ result: "PASS", edition: client ? "work-client" : "gateway",
    invisible: cleanupOnly ? undefined : invisible, deleted: 1,
    conversationStatus: conversations.length ? 2 : "absent" }));
} catch (error) {
  console.error(JSON.stringify({ result: "FAIL", status: error.status, reason: error.reason,
    check: error.code === "ERR_ASSERTION" ? error.message : "The live request or cleanup did not complete.",
    cleanup: history.status(), upstreamFailure, pendingCleanup: Boolean(observed?.conversationId || pending) }));
  process.exitCode = 1;
}
