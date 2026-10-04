import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Coalescer, CancelledError } from '../src/coalesce.js';
import { ManualScheduler } from '../src/scheduler.js';

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

/** Drain the microtask queue so settled computations run their callbacks. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

function report(t: TestContext, label: string, c: Coalescer): void {
  t.diagnostic(`${label}: compute calls = ${c.callCount}, inflight = ${c.inflightCount}`);
}

describe('Coalescer', () => {
  it('shares one computation among concurrent waiters of the same key', async (t) => {
    const c = new Coalescer({ failureTtlMs: 1000, scheduler: new ManualScheduler() });
    const d = deferred<string>();
    const compute = (_signal: AbortSignal): Promise<string> => d.promise;

    const h1 = c.run('k', compute);
    const h2 = c.run('k', compute);
    const h3 = c.run('k', compute);
    d.resolve('shared-result');

    assert.equal(await h1.promise, 'shared-result');
    assert.equal(await h2.promise, 'shared-result');
    assert.equal(await h3.promise, 'shared-result');
    assert.equal(c.callCount, 1);
    assert.equal(c.inflightCount, 0);
    report(t, '3 waiters / 1 key', c);
  });

  it('does not coalesce across different keys', async (t) => {
    const c = new Coalescer({ failureTtlMs: 1000, scheduler: new ManualScheduler() });
    const h1 = c.run('a', async () => 'A');
    const h2 = c.run('b', async () => 'B');
    assert.equal(await h1.promise, 'A');
    assert.equal(await h2.promise, 'B');
    assert.equal(c.callCount, 2);
    report(t, '2 keys', c);
  });

  it('never invokes the compute argument of a joining waiter', async (t) => {
    const c = new Coalescer({ failureTtlMs: 1000, scheduler: new ManualScheduler() });
    const d = deferred<number>();
    c.run('k', () => d.promise);
    const intruder = c.run('k', () => {
      throw new Error('joining compute must never run');
    });
    d.resolve(7);
    assert.equal(await intruder.promise, 7);
    assert.equal(c.callCount, 1);
    report(t, 'joining waiter', c);
  });

  it('single waiter cancel does not affect the remaining waiters', async (t) => {
    const c = new Coalescer({ failureTtlMs: 1000, scheduler: new ManualScheduler() });
    const d = deferred<string>();
    let observedSignal: AbortSignal | undefined;
    const compute = (signal: AbortSignal): Promise<string> => {
      observedSignal = signal;
      return d.promise;
    };

    const h1 = c.run('k', compute);
    const h2 = c.run('k', compute);
    h1.cancel();

    await assert.rejects(h1.promise, (err: unknown) => err instanceof CancelledError);
    assert.equal(observedSignal?.aborted, false, 'computation must NOT be aborted');
    assert.equal(c.inflightCount, 1, 'computation still in flight for h2');

    d.resolve('for-h2');
    assert.equal(await h2.promise, 'for-h2');
    assert.equal(c.callCount, 1);
    report(t, '1 of 2 waiters cancelled', c);
  });

  it('aborts the computation only when ALL waiters cancel', async (t) => {
    const c = new Coalescer({ failureTtlMs: 1000, scheduler: new ManualScheduler() });
    const d = deferred<string>();
    let observedSignal: AbortSignal | undefined;
    const compute = (signal: AbortSignal): Promise<string> => {
      observedSignal = signal;
      return d.promise;
    };

    const h1 = c.run('k', compute);
    const h2 = c.run('k', compute);
    // Attach rejection handlers BEFORE cancelling so neither rejection can
    // be observed as unhandled across an event-loop turn.
    const h1Rejection = assert.rejects(h1.promise, CancelledError);
    const h2Rejection = assert.rejects(h2.promise, CancelledError);
    await flush(); // let the deferred compute() observe its signal first
    h1.cancel();
    assert.equal(observedSignal?.aborted, false);
    h2.cancel();
    assert.equal(observedSignal?.aborted, true, 'last cancel aborts the computation');
    assert.equal(c.inflightCount, 0);
    await h1Rejection;
    await h2Rejection;

    // A fresh call after full cancellation starts a brand-new computation.
    const h3 = c.run('k', async () => 'fresh');
    assert.equal(await h3.promise, 'fresh');
    assert.equal(c.callCount, 2);
    report(t, 'all waiters cancelled, then retry', c);
  });

  it('cancel is idempotent and a no-op after settlement', async (t) => {
    const c = new Coalescer({ failureTtlMs: 1000, scheduler: new ManualScheduler() });
    const d = deferred<string>();
    const h1 = c.run('k', () => d.promise);
    h1.cancel();
    h1.cancel();
    h1.cancel();
    await assert.rejects(h1.promise, CancelledError);
    assert.equal(c.inflightCount, 0);

    const h2 = c.run('k', () => d.promise);
    d.resolve('done');
    assert.equal(await h2.promise, 'done');
    h2.cancel(); // already settled: must not throw or corrupt state
    assert.equal(c.inflightCount, 0);
    assert.equal(c.callCount, 2);
    report(t, 'idempotent cancel', c);
  });

  it('caches failures only for the configured virtual TTL', async (t) => {
    const scheduler = new ManualScheduler();
    const c = new Coalescer({ failureTtlMs: 1000, scheduler });
    const boom = new Error('boom');
    let impl: () => Promise<string> = async () => {
      throw boom;
    };

    await assert.rejects(c.run('k', () => impl()).promise, (e: unknown) => e === boom);
    assert.equal(c.callCount, 1);
    assert.equal(c.hasCachedFailure('k'), true);

    // Within TTL: served from cache, compute NOT invoked again.
    await assert.rejects(c.run('k', () => impl()).promise, (e: unknown) => e === boom);
    assert.equal(c.callCount, 1);
    report(t, 'failure cached @t=0', c);

    scheduler.advance(999);
    await assert.rejects(c.run('k', () => impl()).promise, (e: unknown) => e === boom);
    assert.equal(c.callCount, 1, 'still cached 1ms before expiry');

    scheduler.advance(1); // reach exactly t=1000 -> TTL expires
    assert.equal(c.hasCachedFailure('k'), false, 'cache evicted at TTL');

    impl = async () => 'recovered';
    assert.equal(await c.run('k', () => impl()).promise, 'recovered');
    assert.equal(c.callCount, 2, 'compute re-invoked after TTL expiry');
    report(t, 'after TTL expiry', c);
  });

  it('late success after the last cancel does not resurrect the generation', async (t) => {
    const c = new Coalescer({ failureTtlMs: 1000, scheduler: new ManualScheduler() });
    const d = deferred<string>();
    const h1 = c.run('k', () => d.promise);
    h1.cancel();
    await assert.rejects(h1.promise, CancelledError);
    assert.equal(c.inflightCount, 0);

    // The cancelled computation finishes anyway — too late.
    d.resolve('stale-value');
    await flush();

    assert.equal(c.inflightCount, 0, 'stale completion must not re-register');
    const h2 = c.run('k', async () => 'fresh-value');
    assert.equal(await h2.promise, 'fresh-value');
    assert.equal(c.callCount, 2, 'stale result must not be reused');
    report(t, 'late success after cancel', c);
  });

  it('late failure after the last cancel is NOT written to the failure cache', async (t) => {
    const scheduler = new ManualScheduler();
    const c = new Coalescer({ failureTtlMs: 60_000, scheduler });
    const d = deferred<string>();
    const h1 = c.run('k', () => d.promise);
    h1.cancel();
    await assert.rejects(h1.promise, CancelledError);

    // The aborted computation rejects late (e.g. with an AbortError).
    d.reject(new Error('aborted-late'));
    await flush();

    assert.equal(c.hasCachedFailure('k'), false, 'stale failure must not be cached');
    const h2 = c.run('k', async () => 'fresh-value');
    assert.equal(await h2.promise, 'fresh-value');
    assert.equal(c.callCount, 2, 'no poisoned cache: fresh compute runs');
    report(t, 'late failure after cancel', c);
  });

  it('stale completion cannot clobber a newer generation of the same key', async (t) => {
    const c = new Coalescer({ failureTtlMs: 1000, scheduler: new ManualScheduler() });
    const d1 = deferred<string>();
    const d2 = deferred<string>();

    const h1 = c.run('k', () => d1.promise);
    h1.cancel(); // generation 1 torn down
    await assert.rejects(h1.promise, CancelledError);

    const h2 = c.run('k', () => d2.promise); // generation 2 starts
    assert.equal(c.callCount, 2);

    d1.resolve('old-gen'); // stale completion interleaves with generation 2
    await flush();
    assert.equal(c.inflightCount, 1, 'generation 2 must survive the stale completion');

    d2.resolve('new-gen');
    assert.equal(await h2.promise, 'new-gen');
    assert.equal(c.inflightCount, 0);
    assert.equal(c.callCount, 2);
    report(t, 'stale vs new generation', c);
  });

  it('works with the default real-timer scheduler', async (t) => {
    const c = new Coalescer({ failureTtlMs: 30 });
    const boom = new Error('real-timer-boom');
    await assert.rejects(c.run('k', async () => {
      throw boom;
    }).promise, (e: unknown) => e === boom);
    assert.equal(c.callCount, 1);
    await assert.rejects(c.run('k', async () => 'unreachable').promise, (e: unknown) => e === boom);
    assert.equal(c.callCount, 1, 'cached within real TTL');

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 60);
    });
    assert.equal(await c.run('k', async () => 'recovered').promise, 'recovered');
    assert.equal(c.callCount, 2, 'cache expired in real time');
    report(t, 'real scheduler', c);
  });
});
