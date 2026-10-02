import test from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler } from '../src/scheduler.js';

function drain(scheduler) {
  const dispatched = [];
  for (;;) {
    const item = scheduler.next();
    if (!item) break;
    dispatched.push(item);
  }
  return dispatched;
}

test('aging bounds starvation: low-weight tenant is served within the theoretical bound', () => {
  const quotas = {
    heavy: { ratePerSec: 100000, weight: 4 },
    light: { ratePerSec: 100000, weight: 1 },
  };
  const agingFactor = 10; // weight units per second of waiting
  const scheduler = new Scheduler({ quotas, agingFactor, quantumMs: 5 });
  for (let i = 0; i < 200; i += 1) scheduler.enqueue({ tenant: 'heavy', seq: i });
  for (let i = 0; i < 200; i += 1) scheduler.enqueue({ tenant: 'light', seq: i });

  const bound = scheduler.starvationBoundMs('light');
  // bound = (4/1 - 1) * 1000 / 10 + 5 = 305 ms
  assert.equal(bound, 305);

  const dispatched = drain(scheduler);
  assert.equal(dispatched.length, 400);
  // The bound applies to head-of-line waiting: once a record becomes its
  // tenant's head (previous same-tenant record was dispatched), it must be
  // served within the bound. Queueing behind one's own tenant is not starvation.
  const lastDispatchAt = new Map();
  let maxHeadWait = 0;
  for (const d of dispatched) {
    if (d.tenant !== 'light') continue;
    const headSince = lastDispatchAt.get('light') ?? d.enqueuedAt;
    maxHeadWait = Math.max(maxHeadWait, d.dispatchedAt - headSince);
    lastDispatchAt.set('light', d.dispatchedAt);
  }
  assert.ok(
    maxHeadWait <= bound,
    `light tenant max head-of-line wait ${maxHeadWait}ms exceeds bound ${bound}ms`,
  );
  // aging actually kicked in: light was served long before heavy was exhausted
  const firstLight = dispatched.findIndex((d) => d.tenant === 'light');
  assert.ok(firstLight < 200, `first light dispatch at index ${firstLight}, expected interleaving`);
});

test('without aging the low-weight tenant waits for competitors to drain', () => {
  const quotas = {
    heavy: { ratePerSec: 100000, weight: 4 },
    light: { ratePerSec: 100000, weight: 1 },
  };
  const scheduler = new Scheduler({ quotas, agingFactor: 0, quantumMs: 5 });
  for (let i = 0; i < 50; i += 1) scheduler.enqueue({ tenant: 'heavy', seq: i });
  for (let i = 0; i < 10; i += 1) scheduler.enqueue({ tenant: 'light', seq: i });
  const dispatched = drain(scheduler);
  const firstLight = dispatched.findIndex((d) => d.tenant === 'light');
  assert.equal(firstLight, 50); // strictly after every heavy record
});

test('rate quota is a hard cap: aging never creates tokens', () => {
  const quotas = {
    slow: { ratePerSec: 10, weight: 1000 }, // huge weight, tiny rate
    fast: { ratePerSec: 100000, weight: 1 },
  };
  const scheduler = new Scheduler({ quotas, agingFactor: 100, quantumMs: 1 });
  for (let i = 0; i < 20; i += 1) scheduler.enqueue({ tenant: 'slow', seq: i });
  for (let i = 0; i < 20; i += 1) scheduler.enqueue({ tenant: 'fast', seq: i });
  const dispatched = drain(scheduler);
  assert.equal(dispatched.length, 40);
  // slow tenant: bucket starts full (burst of 10), the rest only after refill time passes
  const slowTimes = dispatched.filter((d) => d.tenant === 'slow').map((d) => d.dispatchedAt);
  const tenth = slowTimes[9];
  const eleventh = slowTimes[10];
  assert.ok(eleventh - tenth >= 89, `rate cap violated: ${eleventh - tenth}ms between tokens`);
  // total elapsed must respect the token bucket: 20 records at 10/s => >= 1s of virtual time
  const last = slowTimes[19];
  assert.ok(last >= 999, `slow tenant dispatched 20 records in ${last}ms with rate 10/s`);
});

test('fairness: equal weights get interleaved service', () => {
  const quotas = {
    a: { ratePerSec: 100000, weight: 1 },
    b: { ratePerSec: 100000, weight: 1 },
  };
  const scheduler = new Scheduler({ quotas, agingFactor: 1, quantumMs: 1 });
  for (let i = 0; i < 30; i += 1) scheduler.enqueue({ tenant: 'a', seq: i });
  for (let i = 0; i < 30; i += 1) scheduler.enqueue({ tenant: 'b', seq: i });
  const dispatched = drain(scheduler);
  // longest run of a single tenant must be short under equal weights + aging
  let run = 1;
  let maxRun = 1;
  for (let i = 1; i < dispatched.length; i += 1) {
    run = dispatched[i].tenant === dispatched[i - 1].tenant ? run + 1 : 1;
    maxRun = Math.max(maxRun, run);
  }
  assert.ok(maxRun <= 3, `max run ${maxRun} too long for equal-weight tenants`);
});
