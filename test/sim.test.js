'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const {
  simulate,
  generateArrivals,
  minimizePrefix,
  IncrementalSimulator,
  SimError,
} = require('../index');

// ---------------------------------------------------------------------------
// Acceptance 1: 12-event scenario checked against a hand-enumerated reference.
// S0(cap1,proc2) -> B0(cap2) -> S1(cap1,proc3); arrivals A@0, B@3; fifo.
// ---------------------------------------------------------------------------
test('12-event trace matches hand-enumerated reference', () => {
  const result = simulate({
    stations: [
      { cap: 1, proc: 2 },
      { cap: 1, proc: 3 },
    ],
    buffers: [{ cap: 2 }],
    arrivals: [
      { id: 'A', time: 0 },
      { id: 'B', time: 3 },
    ],
    policy: 'fifo',
  });

  const expected = [
    { time: 0, type: 'arrival', job: 'A' },
    { time: 0, type: 'start', job: 'A', station: 0 },
    { time: 2, type: 'complete', job: 'A', station: 0 },
    { time: 2, type: 'start', job: 'A', station: 1 },
    { time: 3, type: 'arrival', job: 'B' },
    { time: 3, type: 'start', job: 'B', station: 0 },
    { time: 5, type: 'complete', job: 'A', station: 1 },
    { time: 5, type: 'depart', job: 'A' },
    { time: 5, type: 'complete', job: 'B', station: 0 },
    { time: 5, type: 'start', job: 'B', station: 1 },
    { time: 8, type: 'complete', job: 'B', station: 1 },
    { time: 8, type: 'depart', job: 'B' },
  ];
  assert.deepEqual(result.trace, expected);
  assert.equal(result.status, 'SAFE');
  assert.equal(result.firstViolation, null);
});

// ---------------------------------------------------------------------------
// Acceptance 2: capacity-0 and empty-arrival edge cases do not crash.
// ---------------------------------------------------------------------------
test('capacity 0 and empty arrivals do not crash', () => {
  const empty = simulate({
    stations: [{ cap: 0, proc: 1 }],
    buffers: [],
    arrivals: [],
    policy: 'fifo',
  });
  assert.equal(empty.status, 'SAFE');
  assert.deepEqual(empty.trace, []);
  assert.ok(empty.certificate);

  const blocked = simulate({
    stations: [{ cap: 0, proc: 1 }],
    buffers: [],
    arrivals: [{ id: 'A', time: 0 }],
    policy: 'fifo',
  });
  assert.equal(blocked.status, 'VIOLATION');
  assert.equal(blocked.firstViolation.type, 'station-overflow');

  const zeroBuffer = simulate({
    stations: [
      { cap: 1, proc: 1 },
      { cap: 1, proc: 1 },
    ],
    buffers: [{ cap: 0 }],
    arrivals: [{ id: 'A', time: 0 }],
    policy: 'fifo',
  });
  assert.equal(zeroBuffer.status, 'SAFE');
});

// ---------------------------------------------------------------------------
// Acceptance 3: constructed overflow returns a minimal prefix; deleting any
// single arrival from it removes the overflow.
// S0(cap1,proc1) -> B0(cap1) -> S1(cap1,proc10); arrivals A@0 B@1 C@2 D@3.
// Hand computation: B waits in B0 at t=2, C completes S0 at t=3 with S1 busy
// and B0 full -> buffer-overflow at t=3. Prefix {A,B,C} is 1-minimal.
// ---------------------------------------------------------------------------
const overflowConfig = {
  stations: [
    { cap: 1, proc: 1 },
    { cap: 1, proc: 10 },
  ],
  buffers: [{ cap: 1 }],
  arrivals: [
    { id: 'A', time: 0 },
    { id: 'B', time: 1 },
    { id: 'C', time: 2 },
    { id: 'D', time: 3 },
  ],
  policy: 'fifo',
};

test('overflow violation is detected with earliest time', () => {
  const result = simulate(overflowConfig);
  assert.equal(result.status, 'VIOLATION');
  assert.deepEqual(result.firstViolation, {
    time: 3,
    type: 'buffer-overflow',
    buffer: 0,
    job: 'C',
  });
});

test('minimal prefix: removing any arrival eliminates the overflow', () => {
  const minimal = minimizePrefix(overflowConfig);
  assert.ok(minimal);
  assert.equal(minimal.status, 'VIOLATION');
  assert.deepEqual(
    minimal.arrivals.map((a) => a.id),
    ['A', 'B', 'C'],
  );
  for (const a of minimal.arrivals) {
    const reduced = minimal.arrivals.filter((x) => x !== a);
    const check = simulate({ ...overflowConfig, arrivals: reduced });
    assert.notEqual(check.status, 'VIOLATION', `removing ${a.id} must clear the violation`);
  }
});

// ---------------------------------------------------------------------------
// Acceptance 4: same-time arrivals use a stable tie-break; seeded arrivals
// are reproducible (including across processes).
// ---------------------------------------------------------------------------
test('same-time arrivals are processed in stable seq order', () => {
  const result = simulate({
    stations: [{ cap: 2, proc: 1 }],
    buffers: [],
    arrivals: [
      { id: 'X', time: 0 },
      { id: 'Y', time: 0 },
    ],
    policy: 'fifo',
  });
  const arrivals = result.trace.filter((e) => e.type === 'arrival').map((e) => e.job);
  const completions = result.trace.filter((e) => e.type === 'complete').map((e) => e.job);
  assert.deepEqual(arrivals, ['X', 'Y']);
  assert.deepEqual(completions, ['X', 'Y']);
});

test('seeded arrivals are reproducible in a fresh realm', () => {
  const spec = { seed: 42, count: 20, maxGap: 4, maxPriority: 5 };
  const local = generateArrivals(spec);
  assert.deepEqual(generateArrivals(spec), local);

  // Evaluate the generator sources in a brand-new vm realm: no shared
  // module state can leak between the two evaluations, mirroring what a
  // separate process would see.
  const srcDir = path.join(__dirname, '..', 'src');
  const prngSrc = fs.readFileSync(path.join(srcDir, 'prng.js'), 'utf8');
  const arrivalsSrc = fs.readFileSync(path.join(srcDir, 'arrivals.js'), 'utf8');
  const bundle = `
const prngModule = (function () {
  const module = { exports: {} };
  (function (module, exports) { ${prngSrc} })(module, module.exports);
  return module.exports;
})();
const arrivalsModule = (function () {
  const module = { exports: {} };
  const require = () => prngModule;
  (function (module, exports, require) { ${arrivalsSrc} })(module, module.exports, require);
  return module.exports;
})();
arrivalsModule.generateArrivals(${JSON.stringify(spec)});
`;
  const fresh = vm.runInNewContext(bundle, {}, { filename: 'bundle.js' });
  // Cross-realm values have foreign prototypes; compare structurally.
  assert.deepEqual(JSON.parse(JSON.stringify(fresh)), local);

  const other = generateArrivals({ ...spec, seed: 43 });
  assert.notDeepEqual(other, local);
});

test('same seed reproduces identical traces on repeated runs', () => {
  const config = {
    stations: [
      { cap: 1, proc: 2 },
      { cap: 2, proc: 1 },
    ],
    buffers: [{ cap: 2 }],
    arrivals: { seed: 7, count: 30, maxGap: 3, maxPriority: 4 },
    policy: 'priority',
  };
  const first = simulate(config);
  const second = simulate(config);
  assert.deepEqual(second.trace, first.trace);
  assert.equal(second.status, first.status);
});

// ---------------------------------------------------------------------------
// Errors: negative capacity -> ERR_DOMAIN, event loop -> ERR_CYCLE.
// ---------------------------------------------------------------------------
test('invalid domains raise ERR_DOMAIN', () => {
  const base = {
    stations: [{ cap: 1, proc: 1 }],
    buffers: [],
    arrivals: [],
    policy: 'fifo',
  };
  const cases = [
    { ...base, stations: [{ cap: -1, proc: 1 }] },
    { ...base, stations: [{ cap: 1, proc: -2 }] },
    { ...base, stations: [{ cap: 1, proc: 1 }, { cap: 1, proc: 1 }], buffers: [{ cap: -1 }] },
    { ...base, stations: [{ cap: 1, proc: 1 }, { cap: 1, proc: 1 }], buffers: [] },
    { ...base, policy: 'lifo' },
    { ...base, stations: [] },
  ];
  for (const config of cases) {
    assert.throws(() => simulate(config), (err) => err instanceof SimError && err.code === 'ERR_DOMAIN');
  }
});

test('event loop is detected and reported as ERR_CYCLE', () => {
  assert.throws(
    () =>
      simulate(
        {
          stations: [{ cap: 1, proc: 1 }],
          buffers: [],
          arrivals: [{ id: 'A', time: 0 }],
          policy: 'fifo',
        },
        {
          maxEventsPerTime: 16,
          // Adversarial hook: keeps injecting same-time events forever.
          eventHook: (engine) => engine.schedule(engine.clock, 'injected', {}),
        },
      ),
    (err) => err instanceof SimError && err.code === 'ERR_CYCLE',
  );
});

// ---------------------------------------------------------------------------
// Certificate: SAFE only with finite-horizon state-space coverage;
// UNKNOWN is never SAFE.
// ---------------------------------------------------------------------------
test('SAFE result carries a state-space coverage certificate', () => {
  const result = simulate({
    stations: [
      { cap: 1, proc: 2 },
      { cap: 1, proc: 3 },
    ],
    buffers: [{ cap: 2 }],
    arrivals: [
      { id: 'A', time: 0 },
      { id: 'B', time: 3 },
    ],
    policy: 'fifo',
  });
  assert.equal(result.status, 'SAFE');
  const cert = result.certificate;
  assert.ok(cert);
  assert.equal(cert.queueDrained, true);
  assert.equal(cert.eventsProcessed, 6);
  assert.equal(cert.statesVisited, 7);
  assert.ok(cert.distinctStates <= cert.statesVisited);
  assert.match(cert.digest, /^[0-9a-f]{64}$/);
});

test('horizon truncation yields UNKNOWN, never SAFE', () => {
  const result = simulate(
    {
      stations: [{ cap: 1, proc: 10 }],
      buffers: [],
      arrivals: [{ id: 'A', time: 0 }],
      policy: 'fifo',
    },
    { horizon: 5 },
  );
  assert.equal(result.status, 'UNKNOWN');
  assert.notEqual(result.status, 'SAFE');
  assert.equal(result.certificate, null);
});

// ---------------------------------------------------------------------------
// Starvation: a downstream station that has produced goes idle with an empty
// upstream buffer while work is still pending.
// ---------------------------------------------------------------------------
test('starvation is reported with the earliest time', () => {
  const result = simulate({
    stations: [
      { cap: 1, proc: 1 },
      { cap: 1, proc: 1 },
    ],
    buffers: [{ cap: 1 }],
    arrivals: [
      { id: 'A', time: 0 },
      { id: 'B', time: 10 },
    ],
    policy: 'fifo',
  });
  assert.equal(result.status, 'VIOLATION');
  assert.deepEqual(result.firstViolation, { time: 2, type: 'starvation', station: 1 });
});

// ---------------------------------------------------------------------------
// Policy: fifo vs priority diverge on a contested buffer; priority ties are
// broken stably by seq.
// ---------------------------------------------------------------------------
const contestedConfig = {
  stations: [
    { cap: 1, proc: 1 },
    { cap: 1, proc: 10 },
  ],
  buffers: [{ cap: 3 }],
  arrivals: [
    { id: 'A', time: 0, priority: 0 },
    { id: 'B', time: 1, priority: 1 },
    { id: 'C', time: 2, priority: 9 },
    { id: 'D', time: 3, priority: 3 },
  ],
  policy: 'fifo',
};

test('fifo and priority policies order buffer exits differently', () => {
  const fifo = simulate(contestedConfig);
  const priority = simulate({ ...contestedConfig, policy: 'priority' });
  const exitsOf = (r) => r.trace.filter((e) => e.type === 'buffer-exit').map((e) => e.job);
  assert.deepEqual(exitsOf(fifo), ['B', 'C', 'D']);
  assert.deepEqual(exitsOf(priority), ['C', 'D', 'B']);
  assert.equal(fifo.status, 'SAFE');
  assert.equal(priority.status, 'SAFE');
});

test('priority ties break stably by arrival seq', () => {
  const result = simulate({
    stations: [
      { cap: 1, proc: 1 },
      { cap: 1, proc: 10 },
    ],
    buffers: [{ cap: 3 }],
    arrivals: [
      { id: 'A', time: 0, priority: 0 },
      { id: 'B', time: 1, priority: 5 },
      { id: 'C', time: 2, priority: 5 },
    ],
    policy: 'priority',
  });
  const exits = result.trace.filter((e) => e.type === 'buffer-exit').map((e) => e.job);
  assert.deepEqual(exits, ['B', 'C']);
});

// ---------------------------------------------------------------------------
// Incremental recomputation: a policy change only recomputes the affected
// suffix of events; unaffected changes reuse the whole trace.
// ---------------------------------------------------------------------------
test('policy change recomputes only the affected suffix', () => {
  const inc = new IncrementalSimulator(contestedConfig);
  const initial = inc.run();
  assert.equal(initial.status, 'SAFE');

  const changed = inc.setPolicy('priority');
  assert.equal(changed.changed, true);
  assert.equal(changed.reused, 8);
  assert.equal(changed.recomputed, 4);

  const fresh = simulate({ ...contestedConfig, policy: 'priority' });
  assert.deepEqual(changed.trace, fresh.trace);
  assert.equal(changed.status, fresh.status);
});

test('unaffected policy change reuses the entire trace', () => {
  const inc = new IncrementalSimulator({
    stations: [
      { cap: 1, proc: 2 },
      { cap: 1, proc: 3 },
    ],
    buffers: [{ cap: 2 }],
    arrivals: [
      { id: 'A', time: 0 },
      { id: 'B', time: 3 },
    ],
    policy: 'fifo',
  });
  const initial = inc.run();
  const switched = inc.setPolicy('priority');
  assert.equal(switched.changed, false);
  assert.equal(switched.recomputed, 0);
  assert.deepEqual(switched.trace, initial.trace);
});
