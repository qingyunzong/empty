import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ControlledPromise } from "./controlled-promise.js";
import { StoragePersistenceError } from "./errors.js";
import { ActionExecutor } from "./executor.js";
import { FaultyEventStore, InMemoryEventStore } from "./memory-store.js";
import type {
  EventStore,
  IntentHandler,
  LogEvent,
  ProbeResult,
  ProbeVerdict,
} from "./types.js";

const T = 25;
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

interface Ctx {
  actionCalls: number;
  probeCalls: number;
  probes: ProbeVerdict[];
  action: () => Promise<unknown>;
  handler: IntentHandler;
}

function makeCtx(
  actionImpl: () => Promise<unknown>,
  probeImpl: () => Promise<ProbeResult> | ProbeResult,
): Ctx {
  const ctx: Ctx = {
    actionCalls: 0,
    probeCalls: 0,
    probes: [],
    action: () => {
      ctx.actionCalls += 1;
      return actionImpl();
    },
    handler: {
      action: () => {
        ctx.actionCalls += 1;
        return actionImpl();
      },
      probe: async () => {
        ctx.probeCalls += 1;
        const result = await probeImpl();
        ctx.probes.push(result.verdict);
        return result;
      },
    },
  };
  return ctx;
}

function types(events: LogEvent[]): string[] {
  return events.map((event) => event.type);
}

/** readAll 可被外部控制何时返回，用于精确编排“恢复期间重复提交” */
class DeferredReadStore implements EventStore {
  private gate = new ControlledPromise<void>();
  private readonly inner = new InMemoryEventStore();

  releaseRead(): void {
    this.gate.resolve();
  }

  async readAll(): Promise<LogEvent[]> {
    await this.gate;
    return this.inner.readAll();
  }

  async append(event: LogEvent): Promise<void> {
    await this.inner.append(event);
  }
}

describe("ActionExecutor 基础语义", () => {
  it("动作在超时内成功：只执行一次，正常落盘 resolved", async () => {
    const store = new InMemoryEventStore();
    const executor = new ActionExecutor({ store });
    const done = new ControlledPromise<string>();
    const ctx = makeCtx(() => done, () => ({ verdict: "executed" }));

    const resultP = executor.submit({
      intentId: "i1",
      fingerprint: "fp-1",
      action: ctx.action,
      probe: ctx.handler.probe,
      timeoutMs: T,
    });
    done.resolve("ok");

    const result = await resultP;
    assert.equal(result.outcome, "success");
    assert.equal(result.value, "ok");
    assert.equal(result.attempts, 1);
    assert.equal(ctx.actionCalls, 1);
    assert.equal(ctx.probeCalls, 0);
    assert.equal(executor.getStatus("i1"), "succeeded");
    assert.deepEqual(types(store.snapshot()), [
      "submitted",
      "action_started",
      "resolved",
    ]);
  });

  it("动作显式抛错：记为失败，不调用探测器、不重试", async () => {
    const store = new InMemoryEventStore();
    const executor = new ActionExecutor({ store });
    const ctx = makeCtx(
      async () => {
        throw new Error("页面跳转失败");
      },
      () => ({ verdict: "executed" }),
    );

    const result = await executor.submit({
      intentId: "i-err",
      fingerprint: "fp",
      action: ctx.action,
      probe: ctx.handler.probe,
      timeoutMs: T,
    });

    assert.equal(result.outcome, "failure");
    assert.match(result.reason!, /页面跳转失败/);
    assert.equal(ctx.actionCalls, 1);
    assert.equal(ctx.probeCalls, 0);
    assert.equal(executor.getStatus("i-err"), "failed");
  });
});

describe("超时后只探测，确认未执行才允许再次动作", () => {
  it("超时但探测到已执行：超时后仍成功，动作绝不重试", async () => {
    const store = new InMemoryEventStore();
    const executor = new ActionExecutor({ store });
    const late = new ControlledPromise<string>();
    const ctx = makeCtx(
      () => late,
      () => ({ verdict: "executed", detail: { orderId: "A-1" } }),
    );

    const resultP = executor.submit({
      intentId: "i2",
      fingerprint: "fp-2",
      action: ctx.action,
      probe: ctx.handler.probe,
      timeoutMs: T,
    });

    await sleep(T * 2);
    assert.equal(ctx.actionCalls, 1);
    assert.equal(ctx.probeCalls, 1);

    // 动作的迟到成功不再被使用，结果以只读探测为准
    late.resolve("late-ok");
    const result = await resultP;

    assert.equal(result.outcome, "success");
    assert.equal(result.attempts, 1);
    assert.equal(ctx.actionCalls, 1);
    assert.deepEqual(ctx.probes, ["executed"]);
    assert.deepEqual(types(store.snapshot()), [
      "submitted",
      "action_started",
      "action_timed_out",
      "probed",
      "resolved",
    ]);
  });

  it("探测确认未执行：允许再次动作，第二次成功", async () => {
    const store = new InMemoryEventStore();
    const executor = new ActionExecutor({ store });
    const first = new ControlledPromise<string>();
    const second = new ControlledPromise<string>();
    const firstProbe = new ControlledPromise<ProbeResult>();
    const ctx = makeCtx(
      () => (ctx.actionCalls === 1 ? first : second),
      () =>
        ctx.probes.length === 0
          ? firstProbe
          : Promise.resolve({ verdict: "executed" }),
    );

    const resultP = executor.submit({
      intentId: "i3",
      fingerprint: "fp-3",
      action: ctx.action,
      probe: ctx.handler.probe,
      timeoutMs: T,
      maxRetries: 1,
    });

    await sleep(T * 2);
    assert.equal(ctx.actionCalls, 1);
    assert.equal(ctx.probeCalls, 1);
    // 放行第一次探测（确认未执行），等待第二次动作真正启动
    firstProbe.resolve({ verdict: "not_executed" });
    for (let i = 0; i < 50 && ctx.actionCalls < 2; i += 1) {
      await sleep(2);
    }
    assert.equal(ctx.actionCalls, 2);
    // 第二次尝试同样超时，由第二次探测裁决 executed；放行底层 Promise 不影响结果
    second.resolve("second-ok");

    const result = await resultP;
    assert.equal(result.outcome, "success");
    assert.equal(result.attempts, 2);
    // 第二次尝试在超时窗口内成功：仅第一次超时触发过探测
    assert.deepEqual(ctx.probes, ["not_executed"]);
    assert.equal(result.value, "second-ok");
    assert.deepEqual(types(store.snapshot()).slice(0, 4), [
      "submitted",
      "action_started",
      "action_timed_out",
      "probed",
    ]);
    assert.equal(types(store.snapshot()).at(-1), "resolved");
  });

  it("每次超时都确认未执行、达到重试上限：失败且不再盲目动作", async () => {
    const store = new InMemoryEventStore();
    const executor = new ActionExecutor({ store });
    const ctx = makeCtx(
      () => new ControlledPromise<string>(),
      () => ({ verdict: "not_executed" }),
    );

    const result = await executor.submit({
      intentId: "i4",
      fingerprint: "fp-4",
      action: ctx.action,
      probe: ctx.handler.probe,
      timeoutMs: T,
      maxRetries: 1,
    });

    assert.equal(result.outcome, "failure");
    assert.equal(result.attempts, 2);
    assert.equal(ctx.actionCalls, 2);
    assert.equal(ctx.probeCalls, 2);
  });

  it("探测器裁决 unknown：返回人工决断，禁止重试动作", async () => {
    const store = new InMemoryEventStore();
    const executor = new ActionExecutor({ store });
    const ctx = makeCtx(
      () => new ControlledPromise<string>(),
      () => ({ verdict: "unknown", detail: "页面状态不确定" }),
    );

    const result = await executor.submit({
      intentId: "i5",
      fingerprint: "fp-5",
      action: ctx.action,
      probe: ctx.handler.probe,
      timeoutMs: T,
      maxRetries: 5,
    });

    assert.equal(result.outcome, "manual_review");
    assert.equal(result.status, "manual_review");
    assert.equal(ctx.actionCalls, 1);
    assert.equal(ctx.probeCalls, 1);
    assert.equal(executor.getStatus("i5"), "manual_review");
    assert.ok(types(store.snapshot()).includes("manual_review"));
  });

  it("探测器自身抛错：等价 unknown，升级人工决断而不是重试", async () => {
    const store = new InMemoryEventStore();
    const executor = new ActionExecutor({ store });
    const ctx = makeCtx(
      () => new ControlledPromise<string>(),
      async () => {
        throw new Error("DOM 已变化");
      },
    );

    const result = await executor.submit({
      intentId: "i5b",
      fingerprint: "fp",
      action: ctx.action,
      probe: ctx.handler.probe,
      timeoutMs: T,
    });

    assert.equal(result.outcome, "manual_review");
    assert.equal(ctx.actionCalls, 1);
    assert.equal(ctx.probeCalls, 1);
  });
});

describe("迟到结果不改变探测裁决", () => {
  it("超时后动作迟到 reject：探测已裁决成功，不影响最终结果", async () => {
    const store = new InMemoryEventStore();
    const executor = new ActionExecutor({ store });
    const late = new ControlledPromise<string>();
    const ctx = makeCtx(() => late, () => ({ verdict: "executed" }));

    const resultP = executor.submit({
      intentId: "i6",
      fingerprint: "fp-6",
      action: ctx.action,
      probe: ctx.handler.probe,
      timeoutMs: T,
    });

    await sleep(T * 2);
    late.reject(new Error("连接已断开"));
    const result = await resultP;

    assert.equal(result.outcome, "success");
    assert.equal(ctx.actionCalls, 1);
  });

  it("探测迟到：探测器在动作超时后很久才返回 executed，仍被正确采纳", async () => {
    const store = new InMemoryEventStore();
    const executor = new ActionExecutor({ store });
    const probeDone = new ControlledPromise<ProbeResult>();
    const ctx = makeCtx(
      () => new ControlledPromise<string>(),
      () => probeDone,
    );

    const resultP = executor.submit({
      intentId: "i7",
      fingerprint: "fp-7",
      action: ctx.action,
      probe: ctx.handler.probe,
      timeoutMs: T,
    });

    await sleep(T * 2);
    assert.equal(executor.getStatus("i7"), "running");
    probeDone.resolve({ verdict: "executed", detail: "迟到探测命中" });

    const result = await resultP;
    assert.equal(result.outcome, "success");
    assert.equal(ctx.actionCalls, 1);
    assert.equal(ctx.probeCalls, 1);
  });
});

describe("同一 ID 并发与指纹", () => {
  it("同一 ID 并发提交共享一个结果，动作只执行一次", async () => {
    const store = new InMemoryEventStore();
    const executor = new ActionExecutor({ store });
    const gate = new ControlledPromise<string>();
    const ctx = makeCtx(() => gate, () => ({ verdict: "executed" }));
    const opts = {
      intentId: "i8",
      fingerprint: "fp-8",
      action: ctx.action,
      probe: ctx.handler.probe,
      timeoutMs: T,
    };

    const p1 = executor.submit(opts);
    const p2 = executor.submit({ ...opts });
    const p3 = executor.submit({ ...opts });
    gate.resolve("shared");
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    assert.equal(r1, r2);
    assert.equal(r2, r3);
    assert.equal(ctx.actionCalls, 1);
    assert.equal(ctx.probeCalls, 0);
  });

  it("同一 ID 指纹不一致：直接报错且不额外触发动作", async () => {
    const store = new InMemoryEventStore();
    const executor = new ActionExecutor({ store });
    const gate = new ControlledPromise<string>();
    const ctx = makeCtx(() => gate, () => ({ verdict: "executed" }));
    const base = {
      intentId: "i9",
      action: ctx.action,
      probe: ctx.handler.probe,
      timeoutMs: T,
    };

    const firstP = executor.submit({ ...base, fingerprint: "fp-a" });
    await assert.rejects(
      executor.submit({ ...base, fingerprint: "fp-b" }),
      /前置指纹不一致/
    );
    await assert.rejects(
      executor.submit({ ...base, fingerprint: "fp-b" }),
      /前置指纹不一致/,
    );

    gate.resolve("ok");
    const first = await firstP;
    assert.equal(first.outcome, "success");
    assert.equal(ctx.actionCalls, 1);
  });

  it("已终结的意图重复提交：返回同一结果，指纹不一致仍报错", async () => {
    const store = new InMemoryEventStore();
    const executor = new ActionExecutor({ store });
    const ctx = makeCtx(
      async () => "done",
      () => ({ verdict: "executed" }),
    );

    const first = await executor.submit({
      intentId: "i9b",
      fingerprint: "fp",
      action: ctx.action,
      probe: ctx.handler.probe,
      timeoutMs: T,
    });
    const second = await executor.submit({
      intentId: "i9b",
      fingerprint: "fp",
      action: ctx.action,
      probe: ctx.handler.probe,
      timeoutMs: T,
    });

    assert.equal(first, second);
    assert.equal(ctx.actionCalls, 1);
    await assert.rejects(
      executor.submit({
        intentId: "i9b",
        fingerprint: "other",
        action: ctx.action,
        probe: ctx.handler.probe,
      }),
      /前置指纹不一致/
    );
  });
});


describe("崩溃恢复：先探测未决意图", () => {
  /** 构造一个宿主在动作执行中崩溃后留下的持久日志现场 */
  async function crashedStore(intentId: string, fingerprint: string) {
    const store = new InMemoryEventStore();
    await store.append({
      seq: 1,
      intentId,
      type: "submitted",
      fingerprint,
      at: 1,
    });
    await store.append({
      seq: 2,
      intentId,
      type: "action_started",
      attempt: 1,
      at: 2,
    });
    await store.append({
      seq: 3,
      intentId,
      type: "action_timed_out",
      attempt: 1,
      at: 3,
    });
    return store;
  }

  it("超时后崩溃：新实例只探测不动作，探测到已执行即复用成功", async () => {
    const store = await crashedStore("r1", "fp-r1");
    const ctx = makeCtx(
      () => new ControlledPromise<string>(),
      () => ({ verdict: "executed", detail: "恢复探测命中" }),
    );

    const executor = new ActionExecutor({
      store,
      handlers: { r1: ctx.handler },
    });
    await executor.ready();

    assert.equal(executor.getStatus("r1"), "succeeded");
    assert.equal(executor.getResult("r1")?.outcome, "success");
    assert.equal(executor.getResult("r1")?.attempts, 0);
    assert.equal(ctx.actionCalls, 0);
    assert.equal(ctx.probeCalls, 1);
  });

  it("恢复探测 unknown：人工决断，非幂等动作不会被盲目重试", async () => {
    const store = await crashedStore("r2", "fp");
    const ctx = makeCtx(
      () => new ControlledPromise<string>(),
      () => ({ verdict: "unknown" }),
    );

    const executor = new ActionExecutor({
      store,
      handlers: { r2: ctx.handler },
    });
    await executor.ready();

    assert.equal(executor.getStatus("r2"), "manual_review");
    assert.equal(ctx.actionCalls, 0);
    assert.equal(ctx.probeCalls, 1);
  });

  it("恢复确认未执行：才允许再次动作，且只再执行一次", async () => {
    const store = await crashedStore("r3", "fp");
    const ok = new ControlledPromise<string>();
    const probeGate = new ControlledPromise<ProbeResult>();
    const ctx = makeCtx(() => ok, () => probeGate);

    const executor = new ActionExecutor({
      store,
      handlers: { r3: ctx.handler },
    });
    // 恢复探测先确认“未执行”，随后才允许重新动作
    probeGate.resolve({ verdict: "not_executed" });
    const ready = executor.ready();
    for (let i = 0; i < 10 && ctx.actionCalls < 1; i += 1) {
      await sleep(2);
    }
    assert.equal(ctx.actionCalls, 1);
    ok.resolve("recovered-ok");
    await sleep(0);
    await ready;

    assert.equal(executor.getResult("r3")?.outcome, "success");
    assert.equal(ctx.actionCalls, 1);
    assert.equal(ctx.probeCalls, 1);
  });

  it("无处理器的未决意图：先挂起，submit 并入恢复流程，指纹不符报错", async () => {
    const store = await crashedStore("r4", "fp-r4");
    const executor = new ActionExecutor({ store });
    await executor.ready();
    assert.equal(executor.getStatus("r4"), "running");

    const ctx = makeCtx(
      async () => "should-not-run",
      () => ({ verdict: "executed" }),
    );
    const base = {
      intentId: "r4",
      action: ctx.action,
      probe: ctx.handler.probe,
      timeoutMs: T,
    };
    await assert.rejects(
      executor.submit({ ...base, fingerprint: "wrong" }),
      /FingerprintMismatchError|前置指纹不一致/,
    );
    const result = await executor.submit({ ...base, fingerprint: "fp-r4" });

    assert.equal(result.outcome, "success");
    assert.equal(ctx.actionCalls, 0);
    assert.equal(ctx.probeCalls, 1);
  });

  it("恢复期间重复提交：共享同一个恢复 Promise，探测器只跑一次", async () => {
    const deferred = new DeferredReadStore();
    await deferred.append({
      seq: 1,
      intentId: "r5",
      type: "submitted",
      fingerprint: "fp-r5",
      at: 1,
    });
    const probeDone = new ControlledPromise<ProbeResult>();
    const ctx = makeCtx(
      () => new ControlledPromise<string>(),
      () => probeDone,
    );

    const executor = new ActionExecutor({
      store: deferred,
      handlers: { r5: ctx.handler },
    });
    deferred.releaseRead();

    const base = {
      intentId: "r5",
      fingerprint: "fp-r5",
      action: ctx.action,
      probe: ctx.handler.probe,
      timeoutMs: T,
    };
    const p1 = executor.submit(base);
    const p2 = executor.submit({ ...base });
    probeDone.resolve({ verdict: "executed" });

    const [a, b] = await Promise.all([p1, p2]);
    assert.equal(a, b);
    assert.equal(a.outcome, "success");
    assert.equal(ctx.actionCalls, 0);
    assert.equal(ctx.probeCalls, 1);
  });

  it("已终结意图重放：直接还原结果，不调用任何动作或探测器", async () => {
    const store = new InMemoryEventStore();
    const first = new ActionExecutor({ store });
    const ctx1 = makeCtx(
      async () => "x",
      () => ({ verdict: "executed" }),
    );
    await first.submit({
      intentId: "r6",
      fingerprint: "fp",
      action: ctx1.action,
      probe: ctx1.handler.probe,
      timeoutMs: T,
    });

    const ctx2 = makeCtx(
      async () => "y",
      () => ({ verdict: "not_executed" }),
    );
    const second = new ActionExecutor({
      store,
      handlers: { r6: ctx2.handler },
    });
    await second.ready();

    assert.equal(second.getStatus("r6"), "succeeded");
    assert.equal(second.getResult("r6")?.value, "x");
    assert.equal(ctx2.actionCalls, 0);
    assert.equal(ctx2.probeCalls, 0);
  });
});

describe("故障存储：成功后掉线与写入失败", () => {
  it("动作成功但结果事件写入掉线：submit 报错，恢复后先探测且绝不重复动作", async () => {
    const mem = new InMemoryEventStore();
    const faulty = new FaultyEventStore(mem, {
      failTypes: new Set(["resolved"]),
    });
    const executor1 = new ActionExecutor({ store: faulty });
    const ctx1 = makeCtx(
      async () => "paid",
      () => ({ verdict: "executed" }),
    );

    await assert.rejects(
      executor1.submit({
        intentId: "f1",
        fingerprint: "fp-f1",
        action: ctx1.action,
        probe: ctx1.handler.probe,
        timeoutMs: T,
      }),
      /持久日志写入失败/
    );
    assert.equal(ctx1.actionCalls, 1);

    // 宿主重启，存储恢复
    faulty.clearFaults();
    const ctx2 = makeCtx(
      async () => "paid-again",
      () => ({ verdict: "executed", detail: "支付单已存在" }),
    );
    const executor2 = new ActionExecutor({
      store: faulty,
      handlers: { f1: ctx2.handler },
    });
    const result = await executor2.ready().then(() => executor2.getResult("f1"));

    assert.equal(result?.outcome, "success");
    assert.equal(ctx2.actionCalls, 0);
    assert.equal(ctx2.probeCalls, 1);
    assert.ok(
      mem
        .snapshot()
        .some(
          (event) =>
            event.type === "resolved" &&
            event.intentId === "f1" &&
            event.outcome === "success",
        ),
    );
  });

  it("submitted 事件写入失败：提交直接报错，动作一次都不会执行", async () => {
    const mem = new InMemoryEventStore();
    const faulty = new FaultyEventStore(mem, {
      failTypes: new Set(["submitted"]),
    });
    const executor = new ActionExecutor({ store: faulty });
    const ctx = makeCtx(
      async () => "never",
      () => ({ verdict: "executed" }),
    );

    await assert.rejects(
      executor.submit({
        intentId: "f2",
        fingerprint: "fp",
        action: ctx.action,
        probe: ctx.handler.probe,
      }),
      /持久日志写入失败/
    );
    assert.equal(ctx.actionCalls, 0);
    assert.equal(mem.snapshot().length, 0);
  });

  it("超时后 resolved 掉线：恢复探测 unknown 时也安全落人工决断", async () => {
    const mem = new InMemoryEventStore();
    const faulty = new FaultyEventStore(mem, {
      failTypes: new Set(["resolved"]),
    });
    const executor1 = new ActionExecutor({ store: faulty });
    const ctx1 = makeCtx(
      () => new ControlledPromise<string>(),
      () => ({ verdict: "executed" }),
    );
    const p = executor1
      .submit({
        intentId: "f3",
        fingerprint: "fp",
        action: ctx1.action,
        probe: ctx1.handler.probe,
        timeoutMs: T,
      })
      .then(
        () => "unexpected-resolve",
        (error: unknown) =>
        error instanceof StoragePersistenceError ? "persistence-error" : "other",
      );
    assert.equal(await p, "persistence-error");

    faulty.clearFaults();
    const ctx2 = makeCtx(
      () => new ControlledPromise<string>(),
      () => ({ verdict: "unknown" }),
    );
    const executor2 = new ActionExecutor({
      store: faulty,
      handlers: { f3: ctx2.handler },
    });
    await executor2.ready();

    assert.equal(executor2.getStatus("f3"), "manual_review");
    assert.equal(ctx2.actionCalls, 0);
    assert.equal(ctx2.probeCalls, 1);
  });
});
