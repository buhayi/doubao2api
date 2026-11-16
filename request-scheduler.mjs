// SPDX-License-Identifier: AGPL-3.0-only
const localBusy = (message, retryAfterSeconds = 1) => Object.assign(new Error(message), {
  status: 429, localRateLimit: true, retryAfterSeconds,
});
const abortReason = signal => signal?.reason || new DOMException("请求已取消。", "AbortError");

export function retryAfterMilliseconds(value, now = Date.now()) {
  if (typeof value !== "string" || value.length > 128 || !value.trim()) return;
  const text = value.trim();
  if (!/^\d+$/.test(text) && !/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(text)) return;
  const delay = /^\d+$/.test(text) ? Number(text) * 1000 : Date.parse(text) - now;
  if (Number.isFinite(delay) && delay >= 0) return Math.min(delay, 86400000);
}

// A lease covers the response body, including an entire SSE reply. Queued
// requests retain their own cancellation signal and never retry an upstream call.
export function createRequestScheduler({ minIntervalMs = 1000, maxQueuedRequests = 16, now = Date.now } = {}) {
  if (!Number.isInteger(minIntervalMs) || minIntervalMs < 0 || minIntervalMs > 60000)
    throw Error("请求间隔必须是 0–60000 毫秒的整数。");
  if (!Number.isInteger(maxQueuedRequests) || maxQueuedRequests < 0 || maxQueuedRequests > 128)
    throw Error("上游等待队列上限必须是 0–128 的整数。");
  const accounts = new Map();
  function stateFor(key) {
    let state = accounts.get(key);
    if (state) return state;
    if (accounts.size >= 128) {
      for (const [oldKey, old] of accounts) {
        if (!old.active && !old.releasing && !old.queue.length && !old.timer && Math.max(old.nextAt, old.cooldownUntil) <= now()) {
          accounts.delete(oldKey);
          break;
        }
      }
      if (accounts.size >= 128) throw localBusy("上游请求队列已满，请稍后重试。");
    }
    state = { active: false, releasing: false, queue: [], timer: null, nextAt: 0, cooldownUntil: 0 };
    accounts.set(key, state);
    return state;
  }
  function cooling(state) {
    const seconds = Math.max(1, Math.ceil((state.cooldownUntil - now()) / 1000));
    return Object.assign(new Error(`上游正在限流冷却，请在 ${seconds} 秒后重试。`), {
      status: 429, reason: "rate_limited", retryAfterSeconds: seconds, upstreamCooldown: true,
    });
  }
  function rejectWaiting(state, error) {
    clearTimeout(state.timer);
    state.timer = null;
    for (const job of state.queue.splice(0)) {
      job.signal?.removeEventListener("abort", job.abort);
      job.reject(error);
    }
  }
  function drain(state) {
    if (state.releasing) return;
    clearTimeout(state.timer);
    state.timer = null;
    if (state.active || !state.queue.length) return;
    if (state.cooldownUntil > now()) return rejectWaiting(state, cooling(state));
    const delay = state.nextAt - now();
    if (delay > 0) {
      state.timer = setTimeout(() => drain(state), delay);
      return;
    }
    const job = state.queue.shift();
    job.signal?.removeEventListener("abort", job.abort);
    if (job.signal?.aborted) {
      job.reject(abortReason(job.signal));
      drain(state);
      return;
    }
    state.active = true;
    state.nextAt = now() + minIntervalMs;
    let released = false;
    job.resolve(() => {
      if (released) return;
      released = true;
      state.active = false;
      if (!state.queue.length) return drain(state);
      // Let the just-finished decoder enqueue its history deletion before
      // admitting another long reply. Normal queued work remains FIFO.
      state.releasing = true;
      setTimeout(() => { state.releasing = false; drain(state); }, 0);
    });
  }
  return {
    acquire(key, { signal, cleanup = false } = {}) {
      if (signal?.aborted) return Promise.reject(abortReason(signal));
      let state;
      try {
        state = stateFor(key);
        if (state.cooldownUntil > now()) return Promise.reject(cooling(state));
        // Reserve one cleanup slot even when the normal waiting queue is full.
        // Cleanup still obeys serialization, the start interval and cooldown.
        if ((state.active || state.releasing || state.queue.length || state.nextAt > now()) && state.queue.length >= maxQueuedRequests
          && (!cleanup || state.queue.some(job => job.cleanup)))
          return Promise.reject(localBusy("这个账号的上游等待队列已满，请稍后重试。", Math.max(1, Math.ceil((state.nextAt - now()) / 1000))));
      } catch (error) { return Promise.reject(error); }
      return new Promise((resolve, reject) => {
        const job = { signal, cleanup, resolve, reject };
        job.abort = () => {
          const index = state.queue.indexOf(job);
          if (index < 0) return;
          state.queue.splice(index, 1);
          signal.removeEventListener("abort", job.abort);
          reject(abortReason(signal));
          drain(state);
        };
        const before = cleanup ? state.queue.findIndex(waiting => !waiting.cleanup) : -1;
        if (before < 0) state.queue.push(job);
        else state.queue.splice(before, 0, job);
        signal?.addEventListener("abort", job.abort, { once: true });
        if (signal?.aborted) job.abort();
        else drain(state);
      });
    },
    cooldown(key, durationMs, error) {
      const state = stateFor(key);
      state.cooldownUntil = Math.max(state.cooldownUntil, now() + durationMs);
      rejectWaiting(state, error || cooling(state));
    },
    cancelPending(key, error) {
      const state = accounts.get(key);
      if (state) rejectWaiting(state, error);
    },
    status() {
      let active = 0, queued = 0, coolingAccounts = 0;
      for (const state of accounts.values()) {
        active += Number(state.active);
        queued += state.queue.length;
        coolingAccounts += Number(state.cooldownUntil > now());
      }
      return { serialized: true, minIntervalMs, maxQueuedRequests, active, queued, coolingAccounts };
    },
  };
}

export function scheduledResponse(response, release, signal) {
  if (!response.body) { release(); return response; }
  const reader = response.body.getReader();
  let finished = false, output;
  const finish = () => {
    if (finished) return false;
    finished = true;
    signal?.removeEventListener("abort", abort);
    release();
    return true;
  };
  const unlock = () => { try { reader.releaseLock(); } catch {} };
  const abort = () => {
    if (!finish()) return;
    output.error(abortReason(signal));
    void reader.cancel(signal.reason).catch(() => {}).finally(unlock);
  };
  return new Response(new ReadableStream({
    start(controller) {
      output = controller;
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    },
    async pull(controller) {
      if (finished) return;
      try {
        const part = await reader.read();
        if (finished) return;
        if (part.done) { finish(); unlock(); controller.close(); }
        else controller.enqueue(part.value);
      } catch (error) {
        if (finish()) { unlock(); controller.error(error); }
      }
    },
    async cancel(reason) {
      if (!finish()) return;
      try { await reader.cancel(reason); } finally { unlock(); }
    },
  // Read only on demand: prefetching EOF can release the next request before
  // the SSE decoder has classified a rejection in the preceding packet.
  }, { highWaterMark: 0 }), { status: response.status, statusText: response.statusText, headers: response.headers });
}
