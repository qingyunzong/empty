import { test } from "node:test";
import assert from "node:assert/strict";
import { Scope, ScopeClosedError } from "../src/scope.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

class Tracker {
  readonly live = new Set<string>();
  readonly events: string[] = [];

  acquireFn(name: string): () => Promise<string> {
    return () => {
      this.live.add(name);
      this.events.push(`acquire:${name}`);
      return Promise.resolve(name);
    };
  }

  releaseFn(name: string): (resource: string) => void {
    return (resource) => {
      assert.equal(resource, name, "release 收到的资源应与获取的一致");
      assert.ok(this.live.has(name), `资源 ${name} 不应被重复释放`);
      this.live.delete(name);
      this.events.push(`release:${name}`);
    };
  }

  failingReleaseFn(name: string, error: unknown): (resource: string) => void {
    return (resource) => {
      this.releaseFn(name)(resource);
      throw error;
    };
  }

  assertNoEscape(): void {
    assert.deepEqual([...this.live], [], "不应有逃逸(未释放)的资源");
  }
}

test("嵌套作用域:父关闭时按逆序清理子作用域与全部资源", async () => {
  const tracker = new Tracker();
  const parent = new Scope();

  await parent.acquire(tracker.acquireFn("A"), tracker.releaseFn("A"));
  const child = parent.child();
  await child.acquire(tracker.acquireFn("B"), tracker.releaseFn("B"));
  await child.acquire(tracker.acquireFn("C"), tracker.releaseFn("C"));
  await parent.acquire(tracker.acquireFn("D"), tracker.releaseFn("D"));

  await parent.close();

  assert.deepEqual(tracker.events, [
    "acquire:A",
    "acquire:B",
    "acquire:C",
    "acquire:D",
    "release:D",
    "release:C",
    "release:B",
    "release:A",
  ]);
  tracker.assertNoEscape();
});

test("获取失败不登记:释放器不被调用,其余资源照常清理", async () => {
  const tracker = new Tracker();
  const scope = new Scope();
  let failedReleaseCalls = 0;

  await scope.acquire(tracker.acquireFn("ok"), tracker.releaseFn("ok"));

  const boom = new Error("acquire failed");
  await assert.rejects(
    scope.acquire(
      () => Promise.reject(boom),
      () => {
        failedReleaseCalls += 1;
      },
    ),
    (err: unknown) => err === boom,
  );
  await assert.rejects(
    scope.acquire(
      () => {
        throw boom;
      },
      () => {
        failedReleaseCalls += 1;
      },
    ),
    (err: unknown) => err === boom,
  );

  await scope.close();
  assert.equal(failedReleaseCalls, 0, "获取失败的释放器不应被登记或调用");
  assert.deepEqual(tracker.events, ["acquire:ok", "release:ok"]);
  tracker.assertNoEscape();
});

test("body 异常:逆序清理全部资源,body 错误与清理错误聚合", async () => {
  const tracker = new Tracker();
  const bodyError = new Error("body boom");
  const cleanupError1 = new Error("cleanup boom 1");
  const cleanupError2 = new Error("cleanup boom 2");

  const failure = await Scope.run(async (scope) => {
    await scope.acquire(tracker.acquireFn("one"), tracker.releaseFn("one"));
    await scope.acquire(
      tracker.acquireFn("two"),
      tracker.failingReleaseFn("two", cleanupError2),
    );
    await scope.acquire(
      tracker.acquireFn("three"),
      tracker.failingReleaseFn("three", cleanupError1),
    );
    throw bodyError;
  }).then(
    () => null,
    (err: unknown) => err,
  );

  assert.ok(failure instanceof AggregateError, "应抛出 AggregateError");
  assert.deepEqual(failure.errors, [bodyError, cleanupError1, cleanupError2]);
  assert.deepEqual(tracker.events, [
    "acquire:one",
    "acquire:two",
    "acquire:three",
    "release:three",
    "release:two",
    "release:one",
  ]);
  tracker.assertNoEscape();
});

test("close 聚合多个清理错误且不中断逆序清理", async () => {
  const events: string[] = [];
  const err1 = new Error("fail 1");
  const err2 = new Error("fail 2");
  const scope = new Scope();

  await scope.acquire(
    () => "first",
    () => {
      events.push("release:first");
      throw err1;
    },
  );
  await scope.acquire(
    () => "second",
    () => {
      events.push("release:second");
      throw err2;
    },
  );

  const failure = await scope.close().then(
    () => null,
    (err: unknown) => err,
  );
  assert.ok(failure instanceof AggregateError);
  assert.deepEqual(failure.errors, [err2, err1]);
  assert.deepEqual(events, ["release:second", "release:first"]);
});

test("交错获取:手动控制完成顺序,释放严格按登记逆序", async () => {
  const tracker = new Tracker();
  const scope = new Scope();
  const slow = deferred<string>();
  const fast = deferred<string>();

  const slowAcquire = scope.acquire(
    () => {
      tracker.live.add("slow");
      tracker.events.push("acquire:slow");
      return slow.promise;
    },
    tracker.releaseFn("slow"),
  );
  const fastAcquire = scope.acquire(
    () => {
      tracker.live.add("fast");
      tracker.events.push("acquire:fast");
      return fast.promise;
    },
    tracker.releaseFn("fast"),
  );

  // fast 先完成,先登记;slow 后完成,后登记。
  fast.resolve("fast");
  await fastAcquire;
  slow.resolve("slow");
  await slowAcquire;

  await scope.close();
  assert.deepEqual(tracker.events, [
    "acquire:slow",
    "acquire:fast",
    "release:slow",
    "release:fast",
  ]);
  tracker.assertNoEscape();
});

test("迟到获取:关闭后才完成的获取仍被清理,资源不逃逸", async () => {
  const tracker = new Tracker();
  const scope = new Scope();
  const late = deferred<string>();

  const pending = scope.acquire(
    () => {
      tracker.live.add("late");
      tracker.events.push("acquire:late");
      return late.promise;
    },
    tracker.releaseFn("late"),
  );
  const assertion = assert.rejects(pending, ScopeClosedError);

  await tick();
  await scope.close();
  assert.deepEqual(tracker.events, ["acquire:late"], "关闭时迟到资源尚未登记");

  // 作用域关闭后获取才完成:必须立即释放,且只释放一次。
  late.resolve("late");
  await assertion;
  await tick();

  assert.deepEqual(tracker.events, ["acquire:late", "release:late"]);
  tracker.assertNoEscape();
});

test("单次释放:并发与重复 close 共享同一次清理", async () => {
  const tracker = new Tracker();
  const scope = new Scope();
  const releaseStarted = deferred<void>();
  const releaseContinue = deferred<void>();
  let releaseCount = 0;

  await scope.acquire(tracker.acquireFn("guarded"), async () => {
    releaseCount += 1;
    releaseStarted.resolve();
    await releaseContinue.promise;
    tracker.releaseFn("guarded")("guarded");
  });

  // 清理进行中再次 close,以及清理完成后再 close,都不得重复释放。
  const first = scope.close();
  await releaseStarted.promise;
  const second = scope.close();
  releaseContinue.resolve();
  await Promise.all([first, second]);
  await scope.close();

  assert.equal(releaseCount, 1, "释放器应恰好执行一次");
  tracker.assertNoEscape();
});

test("关闭后获取:直接拒绝且不触发获取函数", async () => {
  const scope = new Scope();
  await scope.close();

  let acquireCalls = 0;
  await assert.rejects(
    scope.acquire(
      () => {
        acquireCalls += 1;
        return "nope";
      },
      () => {},
    ),
    ScopeClosedError,
  );
  assert.equal(acquireCalls, 0, "关闭后不应再调用获取函数");
  assert.ok(scope.isClosed);
});

test("子作用域独立关闭不影响父作用域其余资源", async () => {
  const tracker = new Tracker();
  const parent = new Scope();
  await parent.acquire(tracker.acquireFn("parent-res"), tracker.releaseFn("parent-res"));
  const child = parent.child();
  await child.acquire(tracker.acquireFn("child-res"), tracker.releaseFn("child-res"));

  await child.close();
  assert.deepEqual(tracker.events, [
    "acquire:parent-res",
    "acquire:child-res",
    "release:child-res",
  ]);

  await parent.close();
  assert.deepEqual(tracker.events, [
    "acquire:parent-res",
    "acquire:child-res",
    "release:child-res",
    "release:parent-res",
  ]);
  tracker.assertNoEscape();
});
