import { test } from "node:test";
import assert from "node:assert/strict";
import { LeakyVirtualClock, VirtualClock } from "../src/clocks.ts";
import { waitForStable } from "../src/wait.ts";
import type { VersionedSnapshot } from "../src/types.ts";
import {
  FakePageAdapter,
  ReplayRaceAdapter,
  flushMicrotasks,
} from "./helpers.ts";

interface Doc {
  ready: boolean;
  marker?: string;
}

const isReady = (snapshot: Doc): boolean => snapshot.ready;

test("读-订阅竞争：read 与 subscribe 之间的变化由重放补齐，不遗漏", async () => {
  const adapter = new ReplayRaceAdapter<Doc>(
    { version: 7, snapshot: Object.freeze({ ready: false }) },
    {
      version: 8,
      snapshot: Object.freeze({ ready: false, marker: "missed-1" }),
    },
    {
      version: 9,
      snapshot: Object.freeze({ ready: true, marker: "missed-2" }),
    },
  );
  const clock = new VirtualClock();

  const result = waitForStable({
    adapter,
    predicate: isReady,
    stableForMs: 10,
    clock,
  });

  assert.equal(adapter.subscribeArg, 7);
  assert.deepEqual(adapter.replayLog, [8, 9]);
  clock.advance(10);
  const settled = await result;
  assert.equal(settled.status, "satisfied");
  assert.equal(settled.version, 9);
  assert.equal(settled.snapshot.marker, "missed-2");
  assert.equal(adapter.unsubscribeCalls, 1);
});

test("谓词连续成立满稳定时长后返回对应版本的不可变快照", async () => {
  const adapter = new FakePageAdapter<Doc>({ ready: true, marker: "v1" });
  const clock = new VirtualClock();

  const result = waitForStable({
    adapter,
    predicate: isReady,
    stableForMs: 50,
    clock,
  });

  await flushMicrotasks();
  clock.advance(49);
  await flushMicrotasks();

  clock.advance(50);
  const settled = await result;
  assert.equal(settled.status, "satisfied");
  assert.equal(settled.version, 1);
  assert.equal(settled.snapshot.marker, "v1");
  assert.ok(Object.isFrozen(settled.snapshot));
  assert.throws(() => {
    (settled.snapshot as { marker: string }).marker = "tampered";
  });
});

test("边界变化：期限到达前一刻变化会重新计时，旧期限触发不会成功", async () => {
  const adapter = new FakePageAdapter<Doc>({ ready: true, marker: "v1" });
  const clock = new VirtualClock();

  const result = waitForStable({
    adapter,
    predicate: isReady,
    stableForMs: 50,
    clock,
  });

  clock.advance(49);
  // 新谓词仍成立，但版本变化必须重置连续计时。
  adapter.mutate({ ready: true, marker: "v2" });
  clock.advance(99); // 新版本于 t=49 起计时，期限 t=99 恰好到达。

  const settled = await result;
  assert.equal(settled.status, "satisfied");
  assert.equal(settled.version, 2);
  assert.equal(settled.snapshot.marker, "v2");
  assert.deepEqual(adapter.deliveredVersions, [2]);
});

test("谓词翻为假时清除稳定计时器，再次成立后重新计时", async () => {
  const adapter = new FakePageAdapter<Doc>({ ready: true });
  const clock = new VirtualClock();

  const result = waitForStable({
    adapter,
    predicate: isReady,
    stableForMs: 30,
    clock,
  });

  clock.advance(20);
  adapter.mutate({ ready: false });
  clock.advance(40); // 旧期限本应在 30 到达，但谓词已被打断
  await flushMicrotasks();

  adapter.mutate({ ready: true });
  clock.advance(69); // 新版本于 t=40 起计时，期限 t=70 还差 1ms。
  await flushMicrotasks();
  clock.advance(70); // 期限 t=70 到达。

  const settled = await result;
  assert.equal(settled.status, "satisfied");
  assert.equal(settled.version, 3);
});

test("总超时到达则超时终态；同一时刻稳定成功与超时冲突时超时优先", async () => {
  const adapter = new FakePageAdapter<Doc>({ ready: true });
  const clock = new VirtualClock();

  const result = waitForStable({
    adapter,
    predicate: isReady,
    stableForMs: 100,
    timeoutMs: 100,
    clock,
  });

  clock.advance(100);
  const settled = await result;
  assert.equal(settled.status, "timeout");
  assert.equal(settled.version, 1);
  assert.equal(clock.pendingCount(), 0);
  assert.equal(adapter.unsubscribeCalls, 1);
});

test("总超时早于稳定期限时先超时，并携带最新快照", async () => {
  const adapter = new FakePageAdapter<Doc>({ ready: true });
  const clock = new VirtualClock();

  const result = waitForStable({
    adapter,
    predicate: isReady,
    stableForMs: 100,
    timeoutMs: 40,
    clock,
  });

  clock.advance(25);
  adapter.mutate({ ready: true, marker: "late" });
  clock.advance(40);

  const settled = await result;
  assert.equal(settled.status, "timeout");
  assert.equal(settled.version, 2);
  assert.equal(settled.snapshot.marker, "late");
  assert.equal(adapter.unsubscribeCalls, 1);
});

test("泄漏时钟下同一期限双计时器同时触发，超时仍优先且只有一个终态", async () => {
  const adapter = new FakePageAdapter<Doc>({ ready: true });
  const clock = new LeakyVirtualClock();

  const result = waitForStable({
    adapter,
    predicate: isReady,
    stableForMs: 80,
    timeoutMs: 80,
    clock,
  });

  clock.advance(80);
  const settled = await result;
  assert.equal(settled.status, "timeout");
  assert.equal(adapter.unsubscribeCalls, 1);

  // 僵尸稳定计时器随后再触发也不得改写终态。
  clock.advance(500);
  const again = await result;
  assert.equal(again.status, "timeout");
  assert.strictEqual(again, settled);
});

test("重放补齐后，订阅期间的实时变化仍按版本顺序驱动重新求值", async () => {
  const adapter = new ReplayRaceAdapter<Doc>(
    { version: 1, snapshot: Object.freeze({ ready: false }) },
    { version: 2, snapshot: Object.freeze({ ready: false, marker: "missed" }) },
  );
  const clock = new VirtualClock();

  const result = waitForStable({
    adapter,
    predicate: isReady,
    stableForMs: 25,
    clock,
  });

  assert.deepEqual(adapter.replayLog, [2]);
  clock.advance(10);
  adapter.pushLive({
    version: 3,
    snapshot: Object.freeze({ ready: true, marker: "live" }),
  });
  clock.advance(24);
  await flushMicrotasks();
  clock.advance(35);

  const settled = await result;
  assert.equal(settled.status, "satisfied");
  assert.equal(settled.version, 3);
  assert.equal(settled.snapshot.marker, "live");
  assert.equal(adapter.unsubscribeCalls, 1);
});

test("重放变化会覆盖初始求值：谓词在重放中翻假时不残留稳定计时器", async () => {
  const adapter = new ReplayRaceAdapter<Doc>(
    { version: 1, snapshot: Object.freeze({ ready: true }) },
    { version: 2, snapshot: Object.freeze({ ready: false }) },
    { version: 3, snapshot: Object.freeze({ ready: true }) },
  );
  const clock = new VirtualClock();

  const result = waitForStable({
    adapter,
    predicate: isReady,
    stableForMs: 20,
    clock,
  });

  // 重放顺序 v2（假）→ v3（真），最终只有 v3 的一个稳定计时器挂起。
  assert.deepEqual(adapter.replayLog, [2, 3]);
  clock.advance(19);
  await flushMicrotasks();
  clock.advance(20);

  const settled = await result;
  assert.equal(settled.status, "satisfied");
  assert.equal(settled.version, 3);
  assert.equal(clock.pendingCount(), 0);
});

test("取消与计时器交错：等待中 abort 立即终止并解除订阅", async () => {
  const adapter = new FakePageAdapter<Doc>({ ready: true });
  const clock = new VirtualClock();
  const controller = new AbortController();

  const result = waitForStable({
    adapter,
    predicate: isReady,
    stableForMs: 50,
    timeoutMs: 200,
    clock,
    signal: controller.signal,
  });

  clock.advance(30);
  controller.abort();
  const settled = await result;
  assert.equal(settled.status, "cancelled");
  assert.equal(settled.version, 1);
  assert.equal(adapter.unsubscribeCalls, 1);
  assert.equal(clock.pendingCount(), 0);

  // 终止后的计时器触发与文档变化都是迟到回调，不得再次完成。
  clock.advance(200);
  adapter.mutate({ ready: true, marker: "after-cancel" });
  await flushMicrotasks();
  assert.equal(adapter.unsubscribeCalls, 1);
});

test("启动前已 abort：立即取消，不等待任何计时器", async () => {
  const adapter = new FakePageAdapter<Doc>({ ready: true });
  const clock = new VirtualClock();
  const controller = new AbortController();
  controller.abort();

  const result = waitForStable({
    adapter,
    predicate: isReady,
    stableForMs: 50,
    timeoutMs: 100,
    clock,
    signal: controller.signal,
  });

  const settled = await result;
  assert.equal(settled.status, "cancelled");
  assert.equal(clock.pendingCount(), 0);
  // 订阅尚未建立即取消，因此没有解除订阅动作需要执行。
  assert.equal(adapter.unsubscribeCalls, 0);
});

test("迟到/僵尸计时器触发不会产生第二个终态（泄漏时钟不清除旧计时器）", async () => {
  const adapter = new FakePageAdapter<Doc>({ ready: true });
  const clock = new LeakyVirtualClock();

  const result = waitForStable({
    adapter,
    predicate: isReady,
    stableForMs: 30,
    timeoutMs: 200,
    clock,
  });

  // 连续变化反复重新计时，旧稳定计时器在泄漏时钟中全部保留。
  clock.advance(10);
  adapter.mutate({ ready: true, marker: "v2" });
  clock.advance(20);
  adapter.mutate({ ready: true, marker: "v3" });
  clock.advance(50);

  const settled = await result;
  assert.equal(settled.status, "satisfied");
  assert.equal(settled.version, 3);
  assert.equal(adapter.unsubscribeCalls, 1);

  // 让所有僵尸计时器与总超时计时器都触发一次。
  clock.advance(400);
  adapter.mutate({ ready: true, marker: "v4-after-settle" });
  await flushMicrotasks();
  assert.equal(adapter.unsubscribeCalls, 1);

  // Promise 保持同一终态。
  const again = await result;
  assert.equal(again.status, "satisfied");
  assert.equal(again.version, 3);
});

test("适配器乱序/旧版本投递被忽略，计时不受影响", async () => {
  const adapter = new FakePageAdapter<Doc>({ ready: true });
  const clock = new VirtualClock();
  let captured: ((event: VersionedSnapshot<Doc>) => void) | null = null;
  const originalSubscribe = adapter.subscribe.bind(adapter);
  adapter.subscribe = (afterVersion, onChange) => {
    captured = onChange;
    return originalSubscribe(afterVersion, onChange);
  };

  const result = waitForStable({
    adapter,
    predicate: isReady,
    stableForMs: 40,
    clock,
  });

  assert.ok(captured !== null);
  captured!({ version: 1, snapshot: Object.freeze({ ready: true, marker: "stale" }) });
  captured!({ version: 0, snapshot: Object.freeze({ ready: false }) });
  clock.advance(41);

  const settled = await result;
  assert.equal(settled.status, "satisfied");
  assert.equal(settled.version, 1);
  assert.equal(settled.snapshot.marker, undefined);
});

test("非法参数同步抛出", () => {
  const adapter = new FakePageAdapter<Doc>({ ready: true });
  const clock = new VirtualClock();

  assert.throws(
    () => waitForStable({ adapter, predicate: isReady, stableForMs: 0, clock }),
    RangeError,
  );
  assert.throws(
    () =>
      waitForStable({ adapter, predicate: isReady, stableForMs: -5, clock }),
    RangeError,
  );
  assert.throws(
    () =>
      waitForStable({
        adapter,
        predicate: isReady,
        stableForMs: 10,
        timeoutMs: 0,
        clock,
      }),
    RangeError,
  );
});

test("终态只产生一次：成功路径解除订阅且后续变化被忽略", async () => {
  const adapter = new FakePageAdapter<Doc>({ ready: true });
  const clock = new VirtualClock();

  const result = waitForStable({
    adapter,
    predicate: isReady,
    stableForMs: 20,
    clock,
  });

  clock.advance(20);
  const first = await result;
  assert.equal(first.status, "satisfied");
  assert.equal(adapter.unsubscribeCalls, 1);

  adapter.mutate({ ready: false });
  clock.advance(500);
  await flushMicrotasks();
  const second = await result;
  assert.strictEqual(second, first);
});
