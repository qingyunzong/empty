import test from 'node:test';
import assert from 'node:assert/strict';
import { simulateLine, ERR_DOMAIN, ERR_CYCLE } from '../src/index.js';
import { REFERENCE_CONFIG } from '../test-shared/fixtures.js';

test('12-event trace matches hand-enumerated reference', () => {
  const r = simulateLine(REFERENCE_CONFIG);
  assert.equal(r.status, 'SAFE');
  assert.equal(r.trace.length, 12);
  const got = r.trace.map((e) => [e.time, e.type, e.item]);
  assert.deepEqual(got, [
    [0, 'arrival', 1],
    [0, 'start', 1],
    [1, 'arrival', 2],
    [2, 'complete', 1],
    [2, 'start', 2],
    [2, 'arrival', 3],
    [3, 'arrival', 4],
    [4, 'complete', 2],
    [4, 'start', 3],
    [6, 'complete', 3],
    [6, 'start', 4],
    [8, 'complete', 4],
  ]);
});

test('starvation detected when arrivals are sparse', () => {
  const r = simulateLine({
    stations: [{ cap: 1, proc: 2 }],
    buffers: [{ cap: 1 }, { cap: 1 }],
    arrivals: { times: [0, 10] },
  });
  assert.equal(r.status, 'VIOLATION');
  assert.deepEqual(r.firstViolation, { type: 'starvation', station: 0, time: 2 });
});

test('downstream station starves while upstream station is busy', () => {
  const r = simulateLine({
    stations: [{ cap: 1, proc: 3 }, { cap: 1, proc: 1 }],
    buffers: [{ cap: 1 }, { cap: 1 }, { cap: 1 }],
    arrivals: { times: [0, 1] },
  });
  assert.equal(r.status, 'VIOLATION');
  assert.deepEqual(r.firstViolation, { type: 'starvation', station: 1, time: 4 });
});

test('zero buffer capacity overflows on first arrival without crashing', () => {
  const r = simulateLine({
    stations: [{ cap: 1, proc: 1 }],
    buffers: [{ cap: 0 }, { cap: 0 }],
    arrivals: { times: [0] },
  });
  assert.equal(r.status, 'VIOLATION');
  assert.deepEqual(r.firstViolation, { type: 'bufferOverflow', buffer: 0, item: 1, time: 0 });
});

test('zero station capacity never starves; upstream buffer overflows', () => {
  const r = simulateLine({
    stations: [{ cap: 0, proc: 1 }],
    buffers: [{ cap: 1 }, { cap: 1 }],
    arrivals: { times: [0, 1] },
  });
  assert.equal(r.status, 'VIOLATION');
  assert.deepEqual(r.firstViolation, { type: 'bufferOverflow', buffer: 0, item: 2, time: 1 });
});

test('empty arrivals yields SAFE with empty trace', () => {
  const r = simulateLine({
    stations: [{ cap: 1, proc: 1 }],
    buffers: [{ cap: 1 }, { cap: 1 }],
    arrivals: { times: [] },
  });
  assert.equal(r.status, 'SAFE');
  assert.deepEqual(r.trace, []);
  assert.equal(r.firstViolation, null);
  assert.ok(r.certificate.covered);
  assert.ok(r.certificate.statesExplored >= 1);
});

test('negative capacities and proc raise ERR_DOMAIN', () => {
  const cases = [
    { stations: [{ cap: -1, proc: 1 }], buffers: [{ cap: 1 }, { cap: 1 }] },
    { stations: [{ cap: 1, proc: 1 }], buffers: [{ cap: -2 }, { cap: 1 }] },
    { stations: [{ cap: 1, proc: -0.5 }], buffers: [{ cap: 1 }, { cap: 1 }] },
    { stations: [{ cap: 1.5, proc: 1 }], buffers: [{ cap: 1 }, { cap: 1 }] },
  ];
  for (const c of cases) {
    assert.throws(() => simulateLine({ ...c, arrivals: { times: [] } }), (e) => e.code === ERR_DOMAIN);
  }
});

test('mismatched buffer count and unknown policy raise ERR_DOMAIN', () => {
  assert.throws(
    () => simulateLine({ stations: [{ cap: 1, proc: 1 }], buffers: [{ cap: 1 }], arrivals: { times: [] } }),
    (e) => e.code === ERR_DOMAIN,
  );
  assert.throws(
    () => simulateLine({ stations: [], buffers: [{ cap: 1 }], arrivals: { times: [] }, policy: 'lifo' }),
    (e) => e.code === ERR_DOMAIN,
  );
});

test('self-rescheduling zero-delay custom event raises ERR_CYCLE', () => {
  const apply = (state, ctx) => ctx.schedule(0, apply);
  assert.throws(
    () => simulateLine({
      stations: [],
      buffers: [{ cap: 1 }],
      arrivals: { times: [] },
      customEvents: [{ time: 0, apply }],
      cycleLimit: 50,
    }),
    (e) => e.code === ERR_CYCLE,
  );
});

test('event scheduled in the past raises ERR_CYCLE', () => {
  const apply = (state, ctx) => ctx.schedule(state.time - 1, () => {});
  assert.throws(
    () => simulateLine({
      stations: [],
      buffers: [{ cap: 1 }],
      arrivals: { times: [] },
      customEvents: [{ time: 5, apply }],
    }),
    (e) => e.code === ERR_CYCLE,
  );
});

test('zero-proc-time cascade terminates and is not mistaken for a cycle', () => {
  const r = simulateLine({
    stations: [{ cap: 1, proc: 0 }, { cap: 1, proc: 0 }],
    buffers: [{ cap: 2 }, { cap: 2 }, { cap: 2 }],
    arrivals: { times: [0] },
  });
  assert.equal(r.status, 'SAFE');
  assert.deepEqual(
    r.trace.map((e) => e.type),
    ['arrival', 'start', 'complete', 'start', 'complete'],
  );
});
