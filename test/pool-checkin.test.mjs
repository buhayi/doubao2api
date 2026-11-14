// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createStore } from "../gateway/store.mjs";
import { createPoolCheckin } from "../gateway/checkin.mjs";
import { saveAuth } from "../protocol.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "dw-pool-checkin-test-"));
  assert.equal(dirname(root), resolve(tmpdir()));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createStore(root, { secureRoot: (path) => mkdir(path, { recursive: true, mode: 0o700 }) });
  for (const id of ["a", "b"]) await store.save(saveAuth({ cookieHeader: `sessionid=FIXTURE_${id}`, userId: id, enterpriseType: "0", name: `账号-${id}` }));
  let today = "2026-11-13";
  const checked = new Set(), claims = [];
  const api = { post: async (secret, path) => {
    if (path.endsWith("/launch")) return { data: { ug_campaign_info: { campaign_group_code: "pc_incentive_task_mvp_v3" } } };
    const key = `${secret.userId}:${today}`;
    if (path.endsWith("/claim/")) { claims.push(key); checked.add(key); return { code: 0 }; }
    return { data: { campaign_code: "pc_incentive_task_mvp_v3", tasks: [{ campaign_code: "daily", reward_mode: 2, task_status: 1, daily_checkin: { checked_in_today: checked.has(key) } }] } };
  } };
  const options = { store, api, shutdown: new AbortController().signal, refreshUsage: async () => {}, clock: () => today };
  return { store, api, claims, options, setDay(value) { today = value; } };
}

test("账号池签到：北京时间跨日清除昨天的显示，今日可重新领取且不编造奖励", async (t) => {
  const f = await fixture(t);
  const pool = createPoolCheckin(f.options);
  assert.equal(pool.accountStatus("a:0").outcome, "unchecked");
  await pool.start("a:0");
  await pool.close();
  assert.equal(pool.accountStatus("a:0").outcome, "claimed");
  assert.equal(pool.accountStatus("a:0").credit, undefined);
  f.setDay("2026-11-14");
  assert.equal(pool.accountStatus("a:0").outcome, "unchecked");
  assert.equal(pool.accountStatus("a:0").day, "2026-11-14");
  await pool.start("a:0");
  await pool.close();
  assert.equal(pool.accountStatus("a:0").outcome, "claimed");
  assert.deepEqual(f.claims, ["a:2026-11-13", "a:2026-11-14"]);
});

test("账号池签到：跨进程重启继续使用同日领取记录", async (t) => {
  const f = await fixture(t);
  const first = createPoolCheckin(f.options);
  await first.start("a:0");
  await first.close();
  const restarted = createPoolCheckin({ ...f.options, store: createStore(f.store.root, { secureRoot: async () => {} }) });
  await restarted.start("a:0");
  await restarted.close();
  assert.equal(restarted.status().results[0].outcome, "done");
  assert.deepEqual(f.claims, ["a:2026-11-13"]);
});

test("账号池签到：批量执行跨日时跳过剩余账号，避免混入次日领取", async (t) => {
  const f = await fixture(t);
  const pool = createPoolCheckin({ ...f.options, refreshUsage: async () => f.setDay("2026-11-14") });
  await pool.start();
  await pool.close();
  assert.equal(pool.status().completed, 2);
  assert.equal(pool.status().results[0].outcome, "claimed");
  assert.equal(pool.status().results[1].outcome, "skipped");
  assert.match(pool.status().results[1].message, /跨日/);
  assert.deepEqual(f.claims, ["a:2026-11-13"]);
});
