// SPDX-License-Identifier: AGPL-3.0-only
import { fail } from "../protocol.mjs";

const reasons = new Set(["session_expired", "verification_required", "rate_limited", "upstream_error", "cleanup_timeout", "missing_conversation_id", "invalid_cleanup_response"]);
export function createHistoryCleaner({ api, timeoutMs = 10000, logger = console.warn } = {}) {
  const state = { active: 0, hidden: 0, failed: 0, lastFailure: null };
  const failure = (error) => {
    const reason = reasons.has(error?.reason) ? error.reason : "upstream_error";
    state.failed++;
    state.lastFailure = { reason, at: new Date().toISOString() };
    try { logger(`上游会话隐藏未完成（${reason}），该会话可能仍出现在豆包工作历史列表。`); } catch {}
    return "failed";
  };
  return {
    status: () => ({ ...state, lastFailure: state.lastFailure ? { ...state.lastFailure } : null }),
    async clean(secret, { conversationId, botId, localConversationId }) {
      // Only server-issued IDs from this new request may be archived. A local ID
      // alone is not a lookup key: ConversationInfo can create a blank conversation.
      if (typeof conversationId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(conversationId))
        return failure({ reason: "missing_conversation_id" });
      state.active++;
      const controller = new AbortController();
      let timer;
      try {
        const result = await Promise.race([
          Promise.resolve().then(() => api.post(secret, "/alice/conversation/archive", {
            conversation_id: conversationId, bot_id: botId, local_conversation_id: localConversationId,
          }, { signal: controller.signal })),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              const error = Object.assign(fail(504, "上游会话隐藏超时。"), { reason: "cleanup_timeout" });
              controller.abort(error);
              reject(error);
            }, timeoutMs);
          }),
        ]);
        if (!result || Number(result.code ?? result.error_code ?? NaN) !== 0)
          return failure({ reason: "invalid_cleanup_response" });
        state.hidden++;
        return "hidden";
      } catch (error) { return failure(controller.signal.reason || error); }
      finally { clearTimeout(timer); controller.abort(); state.active--; }
    },
  };
}
