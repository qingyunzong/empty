import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { AppendOnlyLog } from '../src/log.js';
import { injectFaults } from '../src/inject.js';
import { replay } from '../src/replay.js';
import { verify, VERDICT } from '../src/verify.js';

// Acceptance 1: 6 threads of random histories agree with the exponential
// reference enumeration.
test('6 threads: verifier matches exponential reference enumeration', async () => {
  const THREADS = 6;
  const PER_THREAD = 30;
  const results = await Promise.all(
    Array.from({ length: THREADS }, (_, t) =>
      new Promise((resolve, reject) => {
        const worker = new Worker(new URL('../src/worker.js', import.meta.url), {
          workerData: { baseSeed: 1000 + t * 1000, count: PER_THREAD },
        });
        worker.on('message', resolve);
        worker.on('error', reject);
      }),
    ),
  );
  const total = { checked: 0, LINEARIZABLE: 0, VIOLATION: 0, UNKNOWN: 0 };
  const mismatches = [];
  for (const r of results) {
    total.checked += r.checked;
    mismatches.push(...r.mismatches);
    for (const v of Object.values(VERDICT)) total[v] += r.tally[v];
  }
  assert.deepEqual(mismatches, []);
  assert.equal(total.checked, THREADS * PER_THREAD);
  // sanity: the random mix actually exercised both outcomes
  assert.ok(total.LINEARIZABLE > 0, 'expected some LINEARIZABLE histories');
  assert.ok(total.VIOLATION > 0, 'expected some VIOLATION histories');
});

// Acceptance 2: an injected duplicate e-stop still replays to the same state,
// and the injection itself lands in the log.
test('duplicate e-stop injection replays to the same state', () => {
  const log = new AppendOnlyLog();
  const events = [
    { id: 'e0', ts: 1, src: 'safety', kind: 'estop' },
    { id: 'e1', ts: 2, src: 'plc', kind: 'reset_ack' },
    { id: 'e2', ts: 3, src: 'cylinder', kind: 'cyl_done' },
  ];
  for (const e of events) log.append(e);
  const seed = 7;
  const before = replay(events, seed);
  const injected = injectFaults(log, events, [{ type: 'dup', id: 'e0' }]);
  assert.equal(injected.length, events.length + 1);
  const after = replay(injected, seed);
  assert.equal(after.state, before.state);
  // replay is reproducible: same input + seed => identical trace
  assert.deepEqual(replay(injected, seed), after);
  // the injection itself was logged
  const injections = log.records.filter((r) => r.kind === 'injection');
  assert.equal(injections.length, 1);
  assert.deepEqual(injections[0].fault, { type: 'dup', id: 'e0' });
});

// Acceptance 3: a non-linearizable history yields a minimal certificate —
// removing any single item from it makes the history pass.
test('non-linearizable history returns minimal certificate and prefix', () => {
  // Two overlapping cylinder extends with no retract in between: the second
  // extend is not enabled in state CYL_OUT, so no interleaving can work.
  const history = {
    ops: [
      { cmd: 'extend_cylinder', start: 0, end: 10, args: {} },
      { cmd: 'extend_cylinder', start: 1, end: 11, args: {} },
    ],
    events: [
      { id: 'a0', ts: 5, src: 'cylinder', kind: 'cyl_done' },
      { id: 'a1', ts: 6, src: 'cylinder', kind: 'cyl_done' },
    ],
    seed: 0,
  };
  const result = verify(history);
  assert.equal(result.verdict, VERDICT.VIOLATION);

  // minimal violating prefix: the prefix itself violates, one item less does not
  const { prefix } = result;
  assert.ok(prefix && prefix.length >= 1);
  const prefixHistory = {
    ops: prefix.items.filter((i) => i.type === 'op').map((i) => i.op),
    events: prefix.items.filter((i) => i.type === 'event').map((i) => i.event),
    seed: 0,
  };
  assert.equal(verify(prefixHistory).verdict, VERDICT.VIOLATION);
  const shorter = {
    ops: prefix.items
      .slice(0, -1)
      .filter((i) => i.type === 'op')
      .map((i) => i.op),
    events: prefix.items
      .slice(0, -1)
      .filter((i) => i.type === 'event')
      .map((i) => i.event),
    seed: 0,
  };
  assert.notEqual(verify(shorter).verdict, VERDICT.VIOLATION);

  // minimal certificate: still violates, and deleting ANY single item fixes it
  const { certificate } = result;
  assert.ok(certificate.items.length >= 2);
  for (let i = 0; i < certificate.items.length; i++) {
    const reduced = certificate.items.slice(0, i).concat(certificate.items.slice(i + 1));
    const reducedHistory = {
      ops: reduced.filter((x) => x.type === 'op').map((x) => x.op),
      events: reduced.filter((x) => x.type === 'event').map((x) => x.event),
      seed: 0,
    };
    assert.notEqual(
      verify(reducedHistory).verdict,
      VERDICT.VIOLATION,
      `removing item ${i} should make the certificate pass`,
    );
  }
});

// Acceptance 4: an op missing its end keeps the verdict UNKNOWN, and UNKNOWN
// is never reported as a violation.
test('op without end stays UNKNOWN (and UNKNOWN is not VIOLATION)', () => {
  const history = {
    ops: [
      { cmd: 'extend_cylinder', start: 0, end: 10, args: {} },
      { cmd: 'reset', start: 12, end: null, args: {} }, // pending
    ],
    events: [{ id: 'a0', ts: 5, src: 'cylinder', kind: 'cyl_done' }],
    seed: 0,
  };
  const result = verify(history);
  assert.equal(result.verdict, VERDICT.UNKNOWN);
  assert.notEqual(result.verdict, VERDICT.VIOLATION);
  assert.equal(result.pending, 1);
});
