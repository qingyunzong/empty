import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Scope, ScopeClosedError } from "../src/scope.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Flush the microtask queue so settled promises run their continuations. */
async function tick(times = 1): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/** A probe resource whose lifecycle is recorded into a shared event log. */
function probe(events: string[], name: string) {
  return {
    acquire: () => {
      events.push(`acquire:${name}`);
      return name;
    },
    release: () => {
      events.push(`release:${name}`);
    },
  };
}

describe("registration", () => {
  it("registers the finalizer only after a successful acquire", async () => {
    const events: string[] = [];
    const scope = new Scope();
    const ok = probe(events, "ok");
    await scope.acquire(ok.acquire, ok.release);

    const boom = new Error("acquire failed");
    await assert.rejects(
      scope.acquire(
        () => Promise.reject(boom),
        () => {
          events.push("release:bad");
        }
      ),
      (error) => error === boom
    );

    await scope.close();
    assert.deepEqual(events, ["acquire:ok", "release:ok"]);
  });

  it("rejects acquire on a closed scope without calling make", async () => {
    const scope = new Scope();
    await scope.close();
    let makeCalled = false;
    await assert.rejects(
      scope.acquire(
        () => {
          makeCalled = true;
          return "x";
        },
        () => {}
      ),
      (error) => error instanceof ScopeClosedError
    );
    assert.equal(makeCalled, false);
  });
});

describe("cleanup order", () => {
  it("releases in reverse registration order with interleaved async acquisitions", async () => {
    const events: string[] = [];
    const scope = new Scope();
    const gateA = deferred<string>();
    const gateB = deferred<string>();
    const gateC = deferred<string>();

    const a = scope.acquire(() => gateA.promise, probe(events, "a").release);
    const b = scope.acquire(() => gateB.promise, probe(events, "b").release);
    const c = scope.acquire(() => gateC.promise, probe(events, "c").release);

    // Resolve out of start order: registration follows resolution order.
    gateC.resolve("c");
    await tick();
    gateA.resolve("a");
    await tick();
    gateB.resolve("b");
    await Promise.all([a, b, c]);

    await scope.close();
    assert.deepEqual(events, ["release:b", "release:a", "release:c"]);
  });

  it("awaits each release before starting the next one", async () => {
    const events: string[] = [];
    const scope = new Scope();
    const slowRelease = deferred<void>();

    await scope.acquire(probe(events, "first").acquire, probe(events, "first").release);
    await scope.acquire(probe(events, "second").acquire, () => slowRelease.promise);

    const closing = scope.close();
    await tick(3);
    // The newest release is still pending, so the older one must not have run.
    assert.deepEqual(events, ["acquire:first", "acquire:second"]);

    events.push("unblock:second");
    slowRelease.resolve();
    await closing;
    assert.deepEqual(events, [
      "acquire:first",
      "acquire:second",
      "unblock:second",
      "release:first",
    ]);
  });
});

describe("error aggregation", () => {
  it("runs every finalizer and aggregates all failures", async () => {
    const events: string[] = [];
    const scope = new Scope();
    const failA = new Error("release a failed");
    const failC = new Error("release c failed");

    await scope.acquire(probe(events, "a").acquire, () => {
      events.push("release:a");
      throw failA;
    });
    await scope.acquire(probe(events, "b").acquire, probe(events, "b").release);
    await scope.acquire(probe(events, "c").acquire, () => {
      events.push("release:c");
      throw failC;
    });

    const error = await scope.close().then(
      () => assert.fail("close should reject"),
      (caught) => caught
    );
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [failC, failA]);
    // Every finalizer ran, in reverse order, despite the failures.
    assert.deepEqual(events, [
      "acquire:a",
      "acquire:b",
      "acquire:c",
      "release:c",
      "release:b",
      "release:a",
    ]);
  });

  it("rethrows a single cleanup failure as-is", async () => {
    const scope = new Scope();
    const boom = new Error("single failure");
    scope.defer(() => {
      throw boom;
    });
    const error = await scope.close().then(
      () => assert.fail("close should reject"),
      (caught) => caught
    );
    assert.equal(error, boom);
  });
});

describe("nested scopes", () => {
  it("closes children (newest first) before the parent's own finalizers", async () => {
    const events: string[] = [];
    const parent = new Scope();
    await parent.acquire(probe(events, "p1").acquire, probe(events, "p1").release);

    const child1 = new Scope(parent);
    await child1.acquire(probe(events, "c1a").acquire, probe(events, "c1a").release);
    await child1.acquire(probe(events, "c1b").acquire, probe(events, "c1b").release);

    const child2 = new Scope(parent);
    await child2.acquire(probe(events, "c2").acquire, probe(events, "c2").release);

    await parent.acquire(probe(events, "p2").acquire, probe(events, "p2").release);

    await parent.close();
    assert.deepEqual(events, [
      "acquire:p1",
      "acquire:c1a",
      "acquire:c1b",
      "acquire:c2",
      "acquire:p2",
      "release:c2",
      "release:c1b",
      "release:c1a",
      "release:p2",
      "release:p1",
    ]);
  });

  it("a child closed by hand is not released again by the parent", async () => {
    const events: string[] = [];
    const parent = new Scope();
    const child = new Scope(parent);
    await child.acquire(probe(events, "c").acquire, probe(events, "c").release);
    await parent.acquire(probe(events, "p").acquire, probe(events, "p").release);

    await child.close();
    await parent.close();
    assert.deepEqual(events, ["acquire:c", "acquire:p", "release:c", "release:p"]);
  });

  it("aggregates child cleanup failures into the parent's close", async () => {
    const parent = new Scope();
    const child = new Scope(parent);
    const childError = new Error("child cleanup failed");
    child.defer(() => {
      throw childError;
    });
    let parentReleased = false;
    parent.defer(() => {
      parentReleased = true;
    });
    const error = await parent.close().then(
      () => assert.fail("close should reject"),
      (caught) => caught
    );
    assert.equal(error, childError);
    assert.equal(parentReleased, true);
  });
});

describe("late acquisition after close", () => {
  it("releases a resource that resolves after the scope closed", async () => {
    const events: string[] = [];
    const scope = new Scope();
    const gate = deferred<string>();
    let releaseCount = 0;

    const pending = scope.acquire(
      () => gate.promise,
      () => {
        releaseCount++;
        events.push("release:late");
      }
    );
    const expectation = assert.rejects(pending, (error) => error instanceof ScopeClosedError);

    await scope.close();
    assert.equal(scope.isOpen, false);
    assert.equal(releaseCount, 0);

    // The acquisition resolves only now, after the scope is fully closed.
    gate.resolve("late-resource");
    await expectation;
    assert.equal(releaseCount, 1);
    assert.deepEqual(events, ["release:late"]);
  });

  it("aggregates a failing late release with the ScopeClosedError", async () => {
    const scope = new Scope();
    const gate = deferred<string>();
    const releaseError = new Error("late release failed");
    const pending = scope.acquire(
      () => gate.promise,
      () => {
        throw releaseError;
      }
    );
    await scope.close();
    gate.resolve("late-resource");
    const error = await pending.then(
      () => assert.fail("acquire should reject"),
      (caught) => caught
    );
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 2);
    assert.ok(error.errors[0] instanceof ScopeClosedError);
    assert.equal(error.errors[1], releaseError);
  });
});

describe("exactly-once cleanup", () => {
  it("concurrent close calls share a single cleanup run", async () => {
    const scope = new Scope();
    const gate = deferred<void>();
    let releaseCount = 0;
    scope.defer(async () => {
      releaseCount++;
      await gate.promise;
    });

    const first = scope.close();
    const second = scope.close();
    await tick(3);
    assert.equal(releaseCount, 1);

    gate.resolve();
    await Promise.all([first, second]);
    assert.equal(releaseCount, 1);

    await scope.close();
    assert.equal(releaseCount, 1);
  });
});

describe("Scope.run", () => {
  it("releases everything when the body throws and rethrows the body error", async () => {
    const events: string[] = [];
    const boom = new Error("body failed");
    const error = await Scope.run(async (scope) => {
      await scope.acquire(probe(events, "a").acquire, probe(events, "a").release);
      await scope.acquire(probe(events, "b").acquire, probe(events, "b").release);
      throw boom;
    }).then(
      () => assert.fail("run should reject"),
      (caught) => caught
    );
    assert.equal(error, boom);
    assert.deepEqual(events, ["acquire:a", "acquire:b", "release:b", "release:a"]);
  });

  it("aggregates body failure with cleanup failures", async () => {
    const bodyError = new Error("body failed");
    const cleanupError = new Error("cleanup failed");
    const error = await Scope.run(async (scope) => {
      scope.defer(() => {
        throw cleanupError;
      });
      throw bodyError;
    }).then(
      () => assert.fail("run should reject"),
      (caught) => caught
    );
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [bodyError, cleanupError]);
  });

  it("returns the body result on success", async () => {
    const events: string[] = [];
    const result = await Scope.run(async (scope) => {
      await scope.acquire(probe(events, "a").acquire, probe(events, "a").release);
      return 42;
    });
    assert.equal(result, 42);
    assert.deepEqual(events, ["acquire:a", "release:a"]);
  });
});
