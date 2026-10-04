import test from 'node:test';
import assert from 'node:assert/strict';
import { IncrementalSimulation, simulateLine } from '../src/index.js';

// Arrivals: item 1 at t=0 (priority 0), items 2,3 at t=1 (priorities 5,1).
// The station (proc 2) frees at t=2 with buffer 0 = [2,3]: fifo pulls item 2,
// priority pulls item 3. The first four events (before t=2) are unaffected
// by the policy and must be reused.
const CONFIG = {
  stations: [{ cap: 1, proc: 2 }],
  buffers: [{ cap: 4 }, { cap: 4 }],
  arrivals: { times: [0, 1, 1], priorities: [0, 5, 1] },
  policy: 'fifo',
};

test('policy change recomputes only the affected suffix', () => {
  const inc = new IncrementalSimulation(CONFIG);
  const base = inc.run();
  assert.equal(base.firstViolation, null);

  const { result, stats } = inc.setPolicy('priority');
  const fresh = simulateLine({ ...CONFIG, policy: 'priority' });

  // Incremental result equals a full re-simulation under the new policy.
  assert.deepEqual(result.trace, fresh.trace);
  assert.deepEqual(result.firstViolation, fresh.firstViolation);

  // The policy actually matters for this config.
  assert.notDeepEqual(base.trace, fresh.trace);

  // Only the suffix from the divergence point was recomputed.
  assert.equal(stats.divergenceTime, 2);
  assert.equal(stats.reusedEvents, 4);
  assert.equal(stats.recomputedEvents, fresh.trace.length - 4);
  assert.ok(stats.recomputedEvents < stats.totalEvents);

  // Events before the divergence are identical to the original run.
  assert.deepEqual(
    result.trace.slice(0, stats.reusedEvents),
    base.trace.slice(0, stats.reusedEvents),
  );
});

test('re-applying the same policy reuses everything', () => {
  const inc = new IncrementalSimulation(CONFIG);
  const base = inc.run();
  const { result, stats } = inc.setPolicy('fifo');
  assert.equal(stats.divergenceTime, null);
  assert.equal(stats.recomputedEvents, 0);
  assert.equal(stats.reusedEvents, base.trace.length);
  assert.deepEqual(result.trace, base.trace);
});

test('policy without diverging decisions changes nothing downstream', () => {
  // Priorities coincide with fifo order, so priority picks the same items.
  const cfg = {
    stations: [{ cap: 1, proc: 1 }],
    buffers: [{ cap: 4 }, { cap: 4 }],
    arrivals: { times: [0, 0, 1], priorities: [0, 1, 2] },
    policy: 'fifo',
  };
  const inc = new IncrementalSimulation(cfg);
  const base = inc.run();
  const { result, stats } = inc.setPolicy('priority');
  assert.equal(stats.divergenceTime, null);
  assert.equal(stats.recomputedEvents, 0);
  assert.deepEqual(result.trace, base.trace);
});
