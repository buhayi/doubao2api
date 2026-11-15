// SPDX-License-Identifier: AGPL-3.0-only
export const healthStates = new Set(["ok", "expired", "limited", "verification", "error"]);
export const healthSources = new Set(["check", "probe", "request"]);
let operationClock = 0;

export function beginAccountOperation() {
  return operationClock = Math.max(Date.now(), operationClock + 1);
}
export function isInvalidAccount(account) {
  return Boolean(account.health && account.health.state !== "ok");
}
export function isAvailableAccount(account) {
  return account.enabled !== false && !isInvalidAccount(account);
}
export function isUpstreamFailure(error) {
  if (["AbortError", "TimeoutError"].includes(error?.name) || error?.status === 499) return false;
  if (error?.status === 504 && error?.reason !== "upstream_error" && !(Number.isSafeInteger(error?.upstreamCode) && error.upstreamCode > 0)) return false;
  return ["session_expired", "rate_limited", "verification_required", "upstream_error"].includes(error?.reason)
    || Number.isSafeInteger(error?.upstreamCode) && error.upstreamCode > 0
    || [401, 403, 429].includes(error?.status) || error?.status >= 500 || !error?.status;
}
export function failedAccountHealth(error, { source, startedAt }) {
  const state = error?.reason === "verification_required" ? "verification"
    : error?.reason === "session_expired" || error?.status === 401 ? "expired"
    : error?.reason === "rate_limited" || error?.status === 429 ? "limited" : "error";
  // Unexpected exceptions can contain request headers. Only expose messages from
  // the protocol's structured errors, just as the management/API responses do.
  const message = error?.status && typeof error.message === "string" ? error.message
    : "账号请求未完成，请检查连接后探活或重新登录。";
  return { state, source, startedAt, checkedAt: Date.now(), message: message.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 600) };
}
