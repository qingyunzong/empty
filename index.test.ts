import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  emptyState,
  FileStateStore,
  isHivePartitionPath,
  PartitionDiscovery,
  reduceRound,
  type DiscoveryState,
  type ListingBatch,
  type StateStore,
} from "./index.ts";

function batch(
  generation: number,
  entries: Array<{ path: string; complete: boolean }>,
  token = `tok-${generation}`,
): ListingBatch {
  return { generation, continuationToken: token, entries };
}

class MemoryStore implements StateStore {
  state: DiscoveryState | null = null;
  async load(): Promise<DiscoveryState | null> {
    return this.state;
  }
  async save(state: DiscoveryState): Promise<void> {
    this.state = structuredClone(state);
  }
}

test("isHivePartitionPath 校验 hive 风格路径", () => {
  assert.equal(isHivePartitionPath("dt=2026-11-15"), true);
  assert.equal(isHivePartitionPath("dt=2026-11-15/hour=08"), true);
  assert.equal(isHivePartitionPath(""), false);
  assert.equal(isHivePartitionPath("/dt=2026-11-15"), false);
  assert.equal(isHivePartitionPath("dt=2026-11-15/"), false);
  assert.equal(isHivePartitionPath("dt=2026-11-15/plain"), false);
  assert.equal(isHivePartitionPath("dt=/hour=08"), false);
  assert.equal(isHivePartitionPath("1dt=2026"), false);
});

test("新目录需连续两次观察且有完成标记才发布", () => {
  let state = emptyState();

  const first = reduceRound(
    state,
    batch(1, [{ path: "dt=2026-11-15", complete: true }]),
  );
  assert.deepEqual(first.events.published, []);
  assert.equal(first.state.pending["dt=2026-11-15"].consecutiveSeen, 1);

  const second = reduceRound(
    first.state,
    batch(2, [{ path: "dt=2026-11-15", complete: true }]),
  );
  assert.deepEqual(second.events.published, ["dt=2026-11-15"]);
  assert.equal(second.state.pending["dt=2026-11-15"], undefined);
  assert.equal(second.state.published["dt=2026-11-15"].publishedGeneration, 2);
  state = second.state;
});

test("缺少完成标记时即使连续观察也不发布", () => {
  let state = emptyState();
  const noMarker1 = reduceRound(
    state,
    batch(1, [{ path: "dt=2026-11-15", complete: false }]),
  );
  const noMarker2 = reduceRound(
    noMarker1.state,
    batch(2, [{ path: "dt=2026-11-15", complete: false }]),
  );
  assert.deepEqual(noMarker2.events.published, []);

  const withMarker = reduceRound(
    noMarker2.state,
    batch(3, [{ path: "dt=2026-11-15", complete: true }]),
  );
  assert.deepEqual(withMarker.events.published, ["dt=2026-11-15"]);
});

test("中途消失会重置连续观察计数", () => {
  let state = emptyState();
  const r1 = reduceRound(
    state,
    batch(1, [{ path: "dt=2026-11-15", complete: true }]),
  );
  const r2 = reduceRound(r1.state, batch(2, []));
  assert.equal(r2.state.pending["dt=2026-11-15"].consecutiveSeen, 0);
  assert.equal(r2.state.pending["dt=2026-11-15"].markerSeen, true);

  const r3 = reduceRound(
    r2.state,
    batch(3, [{ path: "dt=2026-11-15", complete: true }]),
  );
  assert.deepEqual(r3.events.published, []);
  const r4 = reduceRound(
    r3.state,
    batch(4, [{ path: "dt=2026-11-15", complete: true }]),
  );
  assert.deepEqual(r4.events.published, ["dt=2026-11-15"]);
});

test("已发布分区暂时消失不立即删除，超过阈值才移除", () => {
  let state = emptyState();
  state = reduceRound(
    state,
    batch(1, [{ path: "dt=2026-11-15", complete: true }]),
  ).state;
  state = reduceRound(
    state,
    batch(2, [{ path: "dt=2026-11-15", complete: true }]),
  ).state;
  assert.ok(state.published["dt=2026-11-15"]);

  const miss1 = reduceRound(state, batch(3, []));
  assert.deepEqual(miss1.events.removed, []);
  const miss2 = reduceRound(miss1.state, batch(4, []));
  assert.deepEqual(miss2.events.removed, []);
  const miss3 = reduceRound(miss2.state, batch(5, []));
  assert.deepEqual(miss3.events.removed, ["dt=2026-11-15"]);
  assert.equal(miss3.state.published["dt=2026-11-15"], undefined);
});

test("已发布分区在宽限期内重新出现则取消移除计时", () => {
  let state = emptyState();
  state = reduceRound(
    state,
    batch(1, [{ path: "dt=2026-11-15", complete: true }]),
  ).state;
  state = reduceRound(
    state,
    batch(2, [{ path: "dt=2026-11-15", complete: true }]),
  ).state;

  state = reduceRound(state, batch(3, [])).state;
  state = reduceRound(state, batch(4, [])).state;
  const back = reduceRound(
    state,
    batch(5, [{ path: "dt=2026-11-15", complete: true }]),
  );
  assert.deepEqual(back.events.removed, []);
  assert.equal(back.state.published["dt=2026-11-15"].missingRounds, 0);
});

test("每轮保存 continuation token、清单世代与待确认项", async () => {
  const store = new MemoryStore();
  const discovery = await PartitionDiscovery.open(store);
  await discovery.applyRound(
    batch(7, [{ path: "dt=2026-11-15", complete: false }], "token-abc"),
  );

  const saved = store.state!;
  assert.equal(saved.continuationToken, "token-abc");
  assert.equal(saved.lastGeneration, 7);
  assert.deepEqual(Object.keys(saved.pending), ["dt=2026-11-15"]);
});

test("重启后重放已处理世代不会重复发布", async () => {
  const store = new MemoryStore();
  const discovery = await PartitionDiscovery.open(store);
  await discovery.applyRound(
    batch(1, [{ path: "dt=2026-11-15", complete: true }]),
  );
  const published = await discovery.applyRound(
    batch(2, [{ path: "dt=2026-11-15", complete: true }]),
  );
  assert.deepEqual(published.published, ["dt=2026-11-15"]);

  // 模拟重启：用同一 store 重新打开。
  const restarted = await PartitionDiscovery.open(store);
  const replay = await restarted.applyRound(
    batch(2, [{ path: "dt=2026-11-15", complete: true }]),
  );
  assert.equal(replay.stale, true);
  assert.deepEqual(replay.published, []);

  const next = await restarted.applyRound(
    batch(3, [{ path: "dt=2026-11-15", complete: true }]),
  );
  assert.deepEqual(next.published, []);
  assert.equal(restarted.getState().continuationToken, "tok-3");
});

test("FileStateStore 可持久化并恢复状态", async () => {
  const tmpRoot = process.env.TMPDIR ?? "/tmp";
  const dir = await mkdtemp(join(tmpRoot, "dlks-de-0164-"));
  const store = new FileStateStore(join(dir, "state.json"));

  assert.equal(await store.load(), null);

  const discovery = await PartitionDiscovery.open(store);
  await discovery.applyRound(
    batch(1, [{ path: "dt=2026-11-15", complete: true }], "tok-file"),
  );

  const reopened = await PartitionDiscovery.open(
    new FileStateStore(join(dir, "state.json")),
  );
  const state = reopened.getState();
  assert.equal(state.continuationToken, "tok-file");
  assert.equal(state.lastGeneration, 1);
  assert.ok(state.pending["dt=2026-11-15"]);
});

test("非 hive 风格路径被忽略", () => {
  const { state, events } = reduceRound(
    emptyState(),
    batch(1, [
      { path: "random-dir", complete: true },
      { path: "dt=2026-11-15", complete: true },
    ]),
  );
  assert.deepEqual(events.published, []);
  assert.deepEqual(Object.keys(state.pending), ["dt=2026-11-15"]);
});
