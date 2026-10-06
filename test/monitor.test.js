'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { SafetyMonitor, MonitorError, stateHash, heapPermutations, EXIT_CONSISTENCY } = require('../src/monitor');
const { runScript, recover } = require('../src/engine');
const { Wal, writeCheckpoint } = require('../src/store');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'safemon-'));
}

// Acceptance 1: same batch, different orders, different conclusions => ambiguous=true
test('order-sensitive macro-step sets ambiguous=true', () => {
  const mon = new SafetyMonitor('a b');
  mon.applyBatch([
    { id: 'e1', name: 'a' },
    { id: 'e2', name: 'b' },
  ]);
  // canonical order a,b violates; order b,a would be SAFE
  assert.strictEqual(mon.triState(), 'VIOLATION');
  assert.strictEqual(mon.ambiguous, true);
});

test('order-insensitive macro-step stays unambiguous', () => {
  const mon = new SafetyMonitor('a* b');
  mon.applyBatch([
    { id: 'e1', name: 'a' },
    { id: 'e2', name: 'a' },
  ]);
  // every order is a a, still inside a*: same verdict, no ambiguity
  assert.strictEqual(mon.triState(), 'UNKNOWN');
  assert.strictEqual(mon.ambiguous, false);
});

// Acceptance 2: a confirmed violation is never revoked by later batches
test('violation is sticky and never revoked', () => {
  const mon = new SafetyMonitor('a b');
  mon.applyBatch([{ id: 1, name: 'a' }]);
  mon.applyBatch([{ id: 2, name: 'b' }]);
  assert.strictEqual(mon.triState(), 'VIOLATION');
  mon.applyBatch([{ id: 3, name: 'reset' }]);
  mon.applyBatch([{ id: 4, name: 'c' }]);
  assert.strictEqual(mon.triState(), 'VIOLATION');
});

// Acceptance 3: crash after WAL write but before checkpoint => recover to last complete batch
test('crash before checkpoint recovers to last complete batch', () => {
  const dir = tmpdir();
  const walPath = path.join(dir, 'run.wal');
  const ckptPath = path.join(dir, 'run.ckpt');
  const statuses = [];
  runScript([
    { type: 'init', pattern: 'a b c' },
    { type: 'batch', events: [{ id: 'e1', name: 'a' }] },
    { type: 'checkpoint' },
    { type: 'batch', events: [{ id: 'e2', name: 'b' }] },
    { type: 'batch', events: [{ id: 'e3', name: 'x' }] },
    { type: 'crash' }, // WAL has seq 1..3, checkpoint only covers seq 1
    { type: 'status' },
  ], { walPath, ckptPath, out: (s) => statuses.push(s) });
  assert.strictEqual(statuses.length, 1);
  assert.strictEqual(statuses[0].seq, 3); // last complete batch, replayed from WAL
  assert.strictEqual(statuses[0].state, 'SAFE'); // a b x can never match a b c
});

test('crash with no checkpoint replays the whole WAL', () => {
  const dir = tmpdir();
  const walPath = path.join(dir, 'run.wal');
  const ckptPath = path.join(dir, 'run.ckpt');
  const statuses = [];
  runScript([
    { type: 'init', pattern: 'a b' },
    { type: 'batch', events: [{ id: 'e1', name: 'a' }] },
    { type: 'batch', events: [{ id: 'e2', name: 'b' }] },
    { type: 'crash' },
    { type: 'status' },
  ], { walPath, ckptPath, out: (s) => statuses.push(s) });
  assert.strictEqual(statuses[0].seq, 2);
  assert.strictEqual(statuses[0].state, 'VIOLATION'); // violation survives the crash
});

test('torn tail WAL record is ignored during recovery', () => {
  const dir = tmpdir();
  const walPath = path.join(dir, 'run.wal');
  const ckptPath = path.join(dir, 'run.ckpt');
  runScript([
    { type: 'init', pattern: 'a b' },
    { type: 'batch', events: [{ id: 'e1', name: 'a' }] },
    { type: 'batch', events: [{ id: 'e2', name: 'b' }] },
  ], { walPath, ckptPath, out: () => {} });
  fs.appendFileSync(walPath, '{"seq":3,"events":[{"id":"e3"'); // torn write
  const mon = recover('a b', walPath, ckptPath);
  assert.strictEqual(mon.seq, 2);
  assert.strictEqual(mon.triState(), 'VIOLATION');
});

// Errors: sequence gaps, hash mismatches, duplicate ids => exit code 12
test('sequence gap in WAL is rejected', () => {
  const dir = tmpdir();
  const walPath = path.join(dir, 'run.wal');
  const ckptPath = path.join(dir, 'run.ckpt');
  const wal = new Wal(walPath);
  wal.reset();
  const good = new SafetyMonitor('a b');
  good.applyBatch([{ id: 'e1', name: 'a' }]);
  wal.append({ seq: 1, events: [{ id: 'e1', name: 'a' }], hash: good.hash() });
  wal.append({ seq: 3, events: [{ id: 'e3', name: 'b' }], hash: 'y' });
  assert.throws(() => recover('a b', walPath, ckptPath), (e) => e.code === EXIT_CONSISTENCY && /gap/.test(e.message));
});

test('hash mismatch in WAL is rejected', () => {
  const dir = tmpdir();
  const walPath = path.join(dir, 'run.wal');
  const ckptPath = path.join(dir, 'run.ckpt');
  const wal = new Wal(walPath);
  wal.reset();
  wal.append({ seq: 1, events: [{ id: 'e1', name: 'a' }], hash: 'deadbeef' });
  assert.throws(() => recover('a b', walPath, ckptPath), (e) => e.code === EXIT_CONSISTENCY && /hash mismatch/.test(e.message));
});

test('checkpoint hash mismatch is rejected', () => {
  const dir = tmpdir();
  const walPath = path.join(dir, 'run.wal');
  const ckptPath = path.join(dir, 'run.ckpt');
  new Wal(walPath).reset();
  writeCheckpoint(ckptPath, {
    seq: 1,
    hash: 'bogus',
    state: { dfaKey: '', violation: false, ambiguous: false, seq: 1 },
  });
  assert.throws(() => recover('a b', walPath, ckptPath), (e) => e.code === EXIT_CONSISTENCY && /checkpoint hash mismatch/.test(e.message));
});

test('duplicate event id inside a macro-step is rejected', () => {
  const mon = new SafetyMonitor('a b');
  assert.throws(
    () => mon.applyBatch([{ id: 'e1', name: 'a' }, { id: 'e1', name: 'b' }]),
    (e) => e.code === EXIT_CONSISTENCY && /duplicate event id/.test(e.message),
  );
});

test('explicit batch seq gap in the script is rejected', () => {
  const dir = tmpdir();
  assert.throws(
    () => runScript([
      { type: 'init', pattern: 'a b' },
      { type: 'batch', seq: 1, events: [{ id: 'e1', name: 'a' }] },
      { type: 'batch', seq: 5, events: [{ id: 'e2', name: 'b' }] },
    ], { walPath: path.join(dir, 'w'), ckptPath: path.join(dir, 'c'), out: () => {} }),
    (e) => e.code === EXIT_CONSISTENCY && /gap/.test(e.message),
  );
});

test('CLI exits with code 12 on duplicate ids', () => {
  const dir = tmpdir();
  const script = path.join(dir, 'bad.jsonl');
  fs.writeFileSync(script, [
    JSON.stringify({ type: 'init', pattern: 'a b' }),
    JSON.stringify({ type: 'batch', events: [{ id: 'e1', name: 'a' }, { id: 'e1', name: 'b' }] }),
  ].join('\n') + '\n');
  const res = spawnSync(process.execPath, [path.join(__dirname, '..', 'cli.js'), script], { encoding: 'utf8' });
  assert.strictEqual(res.status, EXIT_CONSISTENCY);
  assert.match(res.stderr, /duplicate event id/);
});

// Acceptance 4: n<=7 macro-steps cross-checked against full permutation enumeration
test('ambiguity and verdict match brute-force permutation enumeration (n<=7)', () => {
  let seed = 123456789;
  const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  const patterns = ['a b', 'a (b|c)+ d', '(a b)* c', '. a', 'a{2,3} b', 'x (a|b)* y'];
  const names = ['a', 'b', 'c', 'd', 'x', 'y'];

  for (let iter = 0; iter < 200; iter++) {
    const pattern = patterns[Math.floor(rand() * patterns.length)];
    const n = 1 + Math.floor(rand() * 7); // batch size 1..7
    const events = [];
    for (let i = 0; i < n; i++) {
      events.push({ id: `e${i}`, name: names[Math.floor(rand() * names.length)] });
    }
    // random prefix of 0..3 earlier batches
    const mon = new SafetyMonitor(pattern);
    const prefixLen = Math.floor(rand() * 4);
    for (let p = 0; p < prefixLen; p++) {
      mon.applyBatch([{ id: `p${p}`, name: names[Math.floor(rand() * names.length)] }]);
    }

    // Independent brute-force reference: enumerate every intra-batch order.
    const before = mon.snapshot();
    const outcomes = new Set();
    for (const perm of heapPermutations(events)) {
      const ref = new SafetyMonitor(pattern);
      ref.restore({ ...before });
      for (const e of perm) ref.applyEvent(e.name);
      outcomes.add(ref.triState());
    }
    const expectAmbiguous = outcomes.size > 1;

    // Canonical tie-break verdict computed independently.
    const canonicalRef = new SafetyMonitor(pattern);
    canonicalRef.restore({ ...before });
    const canonical = events.slice().sort((x, y) => (x.id < y.id ? -1 : 1));
    for (const e of canonical) canonicalRef.applyEvent(e.name);
    const expectTri = canonicalRef.triState();

    const prevAmbiguous = before.ambiguous;
    mon.applyBatch(events);
    assert.strictEqual(mon.triState(), expectTri, `verdict mismatch for ${pattern} / ${JSON.stringify(events)}`);
    assert.strictEqual(mon.ambiguous, prevAmbiguous || expectAmbiguous, `ambiguity mismatch for ${pattern} / ${JSON.stringify(events)}`);
  }
});

// Acceptance 5: UNKNOWN is never reported as UNSAT/SAFE and carries no certificate
test('UNKNOWN never outputs an UNSAT certificate', () => {
  const mon = new SafetyMonitor('a b c');
  mon.applyBatch([{ id: 'e1', name: 'a' }]);
  const status = mon.status();
  assert.strictEqual(status.state, 'UNKNOWN');
  assert.ok(!('certificate' in status), 'no certificate field may be emitted');
  assert.ok(!('unsat' in status), 'no unsat field may be emitted');
  assert.doesNotMatch(JSON.stringify(status), /UNSAT/i);
});

test('SAFE is only reported when no extension can violate', () => {
  const mon = new SafetyMonitor('a b');
  mon.applyBatch([{ id: 'e1', name: 'z' }]); // dead prefix: can never match a b
  assert.strictEqual(mon.triState(), 'SAFE');
  // and SAFE is genuinely safe: arbitrary continuations stay non-violating
  mon.applyBatch([{ id: 'e2', name: 'a' }]);
  mon.applyBatch([{ id: 'e3', name: 'b' }]);
  assert.strictEqual(mon.triState(), 'SAFE');
});

// Hash is a pure function of the logical state
test('state hash is deterministic and state-dependent', () => {
  const h1 = stateHash(1, '0,1', false, false);
  const h2 = stateHash(1, '0,1', false, false);
  const h3 = stateHash(2, '0,1', false, false);
  assert.strictEqual(h1, h2);
  assert.notStrictEqual(h1, h3);
  assert.match(h1, /^[0-9a-f]{64}$/);
});
