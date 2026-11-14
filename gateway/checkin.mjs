// SPDX-License-Identifier: AGPL-3.0-only
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createCheckin, checkinDay } from "../checkin.mjs";
import { fail } from "../protocol.mjs";

const outcomes = new Set(["claimed", "done", "inactive", "ineligible", "captcha", "failed"]);
const successful = new Set(["claimed", "done"]);

function failure(error, signal, shutdown) {
  if (shutdown.aborted) return { outcome: "cancelled", message: "服务已停止，领取记录已保留。" };
  if (signal.aborted) return { outcome: "failed", message: "签到超时，领取结果待核对；再次操作会先查询今日任务。" };
  if (error?.status === 401 || error?.signIn || error?.reason === "session_expired")
    return { outcome: "expired", message: "登录已失效，请重新登录后再签到。" };
  if (error?.status === 429 || error?.reason === "verification_required")
    return { outcome: "captcha", message: "上游要求人工检查，请在官网完成验证后再查询。" };
  if (error?.status === 409)
    return { outcome: "failed", message: "签到记录无法安全读取或写入，请保留记录并检查本机数据目录。" };
  return { outcome: "failed", message: "签到未完成，请稍后查询或重新登录；已有提交不会重复领取。" };
}

function resultView(result) {
  if (!outcomes.has(result?.outcome)) return { outcome: "failed", message: "签到未返回有效结果，请稍后查询。" };
  return {
    outcome: result.outcome,
    message: typeof result.message === "string" ? result.message : "",
    ...(Number.isFinite(result.credit) && result.credit > 0 ? { credit: result.credit } : {}),
    ...(Number.isSafeInteger(result.streak) && result.streak > 0 ? { streak: result.streak } : {}),
  };
}

// Single-account and pool actions share one background queue. HTTP disconnects
// do not cancel a submitted job; server shutdown and per-account timeouts do.
export function createPoolCheckin({ store, api, shutdown, refreshUsage, timeoutMs = 30000, clock = checkinDay } = {}) {
  const engine = createCheckin({ root: join(store.root, "checkins"), api, clock });
  const results = new Map();
  let job;

  function accountStatus(uid) {
    const result = results.get(uid);
    return result?.day === clock() ? result : { day: clock(), outcome: "unchecked" };
  }
  function status() {
    if (!job) return { state: "idle", active: false, day: clock(), total: 0, completed: 0, counts: {}, results: [] };
    const counts = {};
    for (const result of job.results) {
      if (!["queued", "running"].includes(result.outcome)) counts[result.outcome] = (counts[result.outcome] || 0) + 1;
    }
    return {
      id: job.id, kind: job.kind, state: job.state, active: job.active, day: job.day,
      total: job.results.length, completed: job.completed, counts, current: job.current,
      startedAt: job.startedAt, ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
      results: job.results,
    };
  }
  function finishRow(current, index, result) {
    const row = { ...current.results[index], ...result, checkedAt: Date.now() };
    current.results[index] = row;
    results.set(row.uid, row);
    current.completed++;
  }
  async function execute(current) {
    try {
      for (let index = 0; index < current.results.length; index++) {
        if (shutdown.aborted) {
          for (; index < current.results.length; index++) finishRow(current, index, { outcome: "cancelled", message: "服务已停止，尚未执行签到。" });
          break;
        }
        if (clock() !== current.day) {
          finishRow(current, index, { outcome: "skipped", message: "北京时间已跨日，请重新发起今日签到。" });
          continue;
        }
        const row = current.results[index];
        current.current = { uid: row.uid, name: row.name };
        row.outcome = "running";
        row.message = "正在查询今日任务并领取可用奖励。";
        const signal = AbortSignal.any([shutdown, AbortSignal.timeout(timeoutMs)]);
        let result;
        try {
          signal.throwIfAborted();
          const publicAccount = (await store.list()).find((account) => account.uid === row.uid);
          if (!publicAccount) result = { outcome: "skipped", message: "账号已移除，跳过签到。" };
          else {
            const account = await store.account(row.uid, { allowDisabled: true });
            row.name = account.name;
            current.current.name = account.name;
            if (current.kind === "pool" && account.enabled === false) result = { outcome: "skipped", message: "账号已停用，跳过批量签到。" };
            else {
              signal.throwIfAborted();
              result = resultView(await engine.run(account.secret, { signal }));
              if (successful.has(result.outcome)) {
                try { await refreshUsage(account, signal); }
                catch { result.usageError = "签到已确认，额度暂无法刷新，可点击检测重试。"; }
              }
            }
          }
        } catch (error) { result = failure(error, signal, shutdown); }
        finishRow(current, index, result);
      }
    } finally {
      current.active = false;
      current.state = shutdown.aborted ? "cancelled" : "completed";
      current.current = null;
      current.finishedAt = Date.now();
    }
  }
  return {
    accountStatus,
    status,
    async start(uid) {
      if (shutdown.aborted) throw fail(503, "管理台正在关闭，请稍后重试。");
      if (job?.active) throw fail(409, "已有签到任务正在执行，请等待当前任务完成。");
      const list = await store.list();
      // Recheck after I/O so concurrent POSTs cannot start two queues.
      if (job?.active) throw fail(409, "已有签到任务正在执行，请等待当前任务完成。");
      const accounts = uid === undefined ? list.filter((account) => account.enabled) : list.filter((account) => account.uid === uid);
      if (!accounts.length) throw fail(uid === undefined ? 409 : 404, uid === undefined ? "没有已启用的账号，请先添加或启用账号。" : "这个账号已不存在，请刷新账号池。");
      const current = {
        id: randomBytes(12).toString("hex"), kind: uid === undefined ? "pool" : "single",
        day: clock(), state: "running", active: true, completed: 0, current: null, startedAt: Date.now(),
      };
      current.results = accounts.map(({ uid: accountId, name }) => ({ uid: accountId, name, day: current.day, outcome: "queued", message: "等待执行签到。" }));
      for (const row of current.results) results.set(row.uid, row);
      job = current;
      current.promise = execute(current);
      return status();
    },
    forget(uid) { results.delete(uid); },
    async close() { await job?.promise; },
  };
}
