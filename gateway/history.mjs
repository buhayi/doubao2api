// SPDX-License-Identifier: AGPL-3.0-only
import { fail } from "../protocol.mjs";
import { randomUUID } from "node:crypto";

const reasons = new Set(["session_expired", "verification_required", "rate_limited", "upstream_error", "cleanup_timeout", "missing_conversation_id", "invalid_cleanup_response"]);
export function createHistoryCleaner({ api, timeoutMs = 10000, logger = console.warn } = {}) {
  const state = { active: 0, deleted: 0, failed: 0, lastFailure: null };
  const failure = (error) => {
    const reason = reasons.has(error?.reason) ? error.reason : "upstream_error";
    state.failed++;
    state.lastFailure = { reason, at: new Date().toISOString() };
    try { logger(`上游会话删除未完成（${reason}），该会话可能仍保留在豆包工作中。`); } catch {}
    return "failed";
  };
  return {
    status: () => ({ ...state, lastFailure: state.lastFailure ? { ...state.lastFailure } : null }),
    async clean(secret, { conversationId, botId, localConversationId }) {
      // Only server-issued IDs from this new request may be deleted. A local ID
      // alone is not a lookup key: ConversationInfo can create a blank conversation.
      if (typeof conversationId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(conversationId))
        return failure({ reason: "missing_conversation_id" });
      state.active++;
      const controller = new AbortController();
      let timer;
      try {
        const result = await Promise.race([
          // This is the installed Work client's delete action (IM command 4171),
          // not its archive action. Never set delete_all or look up old history.
          Promise.resolve().then(() => api.post(secret, "/im/conversation/batch_del_user_conv", {
            cmd: 4171, sequence_id: randomUUID(), channel: 2, version: "1",
            uplink_body: { batch_delete_user_conversation_uplink_body: {
              conversation_id: [conversationId], delete_all: false, conversation_type: 3,
            } },
          }, { signal: controller.signal })),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              const error = Object.assign(fail(504, "上游会话删除超时。"), { reason: "cleanup_timeout" });
              controller.abort(error);
              reject(error);
            }, timeoutMs);
          }),
        ]);
        if (!result || Number(result.status_code ?? result.code ?? result.error_code ?? NaN) !== 0)
          return failure({ reason: "invalid_cleanup_response" });
        state.deleted++;
        return "deleted";
      } catch (error) { return failure(controller.signal.reason || error); }
      finally { clearTimeout(timer); controller.abort(); state.active--; }
    },
  };
}
