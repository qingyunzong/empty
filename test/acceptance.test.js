import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { simulateLine, generateArrivals } from '../src/index.js';

// One station (cap 1, proc 3), input buffer cap 2, output buffer cap 5,
// arrivals at t = 0..4. Hand analysis: at t=4 item 5 finds buffer 0 full
// ([3,4]) -> overflow. Every arrival is essential: deleting any single one
// lets the rest flow without overflow.
const OVERFLOW_CONFIG = {
  stations: [{ cap: 1, proc: 3 }],
  buffers: [{ cap: 2 }, { cap: 5 }],
  arrivals: { times: [0, 1, 2, 3, 4] },
  policy: 'fifo',
};

test('overflow reports earliest violation and a minimal arrival prefix', () => {
  const r = simulateLine(OVERFLOW_CONFIG);
  assert.equal(r.status, 'VIOLATION');
  assert.deepEqual(r.firstViolation, { type: 'bufferOverflow', buffer: 0, item: 5, time: 4 });
  assert.ok(r.minimalPrefix, 'overflow must carry a minimal prefix');
  assert.equal(r.minimalPrefix.verifies, true);
  assert.deepEqual(r.minimalPrefix.arrivals, [1, 2, 3, 4, 5]);
});

test('deleting any single arrival from the minimal prefix avoids overflow', () => {
  const r = simulateLine(OVERFLOW_CONFIG);
  for (const id of r.minimalPrefix.arrivals) {
    const times = OVERFLOW_CONFIG.arrivals.times.filter((_, i) => i + 1 !== id);
    const sub = simulateLine({ ...OVERFLOW_CONFIG, arrivals: { times } });
    assert.notEqual(
      sub.firstViolation?.type,
      'bufferOverflow',
      `removing arrival ${id} must eliminate the overflow`,
    );
  }
});

test('same-time arrivals are tie-broken stably by item id', () => {
  const r = simulateLine({
    stations: [{ cap: 2, proc: 1 }],
    buffers: [{ cap: 10 }, { cap: 10 }],
    arrivals: { seed: 5, count: 6, maxInterval: 0 },
  });
  const arrivals = r.trace.filter((e) => e.type === 'arrival').map((e) => e.item);
  assert.deepEqual(arrivals, [1, 2, 3, 4, 5, 6]);
  assert.ok(r.trace.every((e) => e.type !== 'arrival' || e.time === 0));
  const startsAt0 = r.trace.filter((e) => e.type === 'start' && e.time === 0).map((e) => e.item);
  assert.deepEqual(startsAt0, [1, 2]);
});

test('same seed reproduces identical results; different seeds differ', () => {
  const cfg = (seed) => ({
    stations: [{ cap: 1, proc: 2 }],
    buffers: [{ cap: 5 }, { cap: 5 }],
    arrivals: { seed, count: 8, maxInterval: 3 },
  });
  const a = simulateLine(cfg(7));
  const b = simulateLine(cfg(7));
  assert.deepEqual(a, b);
  const c = simulateLine(cfg(8));
  const arrivalTimes = (r) => r.trace.filter((e) => e.type === 'arrival').map((e) => e.time);
  assert.notDeepEqual(arrivalTimes(a), arrivalTimes(c));
});

test('seeded arrivals are identical across processes', (t) => {
  const spec = { seed: 42, count: 8, maxInterval: 3 };
  const expected = JSON.stringify(generateArrivals(spec));
  const root = new URL('..', import.meta.url).pathname;
  let out;
  try {
    out = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `import { generateArrivals } from './src/prng.js'; process.stdout.write(JSON.stringify(generateArrivals(${JSON.stringify(spec)})));`,
      ],
      { cwd: root, encoding: 'utf8' },
    );
  } catch (err) {
    // Sandboxed environments may forbid spawning subprocesses; the PRNG is
    // pure integer arithmetic, so cross-process determinism holds by
    // construction and this check is skipped only when spawn is impossible.
    if (err.code === 'EPERM' || err.code === 'EACCES') {
      t.skip('spawning a child process is not permitted in this environment');
      return;
    }
    throw err;
  }
  assert.equal(out, expected);
});
