'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { Settler } = require('../lib/settle');
const { naiveRun } = require('../lib/naive');
const { windowCert, RULES_VERSION } = require('../lib/common');
const { main: cliMain } = require('../cli');

const CLI = path.join(__dirname, '..', 'cli.js');
const WM = 3000;

function run(events) {
  const s = new Settler({ allowedLatenessMs: WM });
  events.forEach((ev, i) => s.process(ev, i + 1));
  return s.finish();
}

function tmpFile(name, content) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'settle-')), name);
  fs.writeFileSync(p, content);
  return p;
}

// In-process CLI invocation with captured log/error output.
function runCliInProcess(args) {
  const logs = [];
  const errs = [];
  const code = cliMain(
    ['node', 'cli.js', ...args],
    { log: (m) => logs.push(m), error: (m) => errs.push(m) }
  );
  return { code, logs, errs };
}

// Real subprocess invocation (exit-code propagation).
function runCliSpawn(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

// Deterministic PRNG (LCG) for property-style tests.
function lcg(seed) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000;
}

test('A: out-of-order events + void before close; cert is recomputable', () => {
  const records = run([
    { type: 'capture', id: 'c3', mch: 'mA', amt: 300, ts: 5000 },
    { type: 'capture', id: 'c1', mch: 'mA', amt: 100, ts: 1000 },
    { type: 'capture', id: 'c2', mch: 'mA', amt: 200, ts: 2000 },
    { type: 'void', id: 'c1', ts: 6000 },
    { type: 'capture', id: 'c9', mch: 'mB', amt: 50, ts: 400000 }, // closes window 0
  ]);
  const finals = records.filter((r) => r.status === 'final');
  assert.equal(finals.length, 2);

  const w0 = finals.find((r) => r.winStart === 0);
  assert.deepEqual(
    { winStart: w0.winStart, winEnd: w0.winEnd, mch: w0.mch, net: w0.net },
    { winStart: 0, winEnd: 300000, mch: 'mA', net: 500 } // c1 voided -> 200+300
  );

  // Recompute the cert independently from the canonical contributing entries.
  const expected = windowCert(0, 300000, 'mA', [
    { id: 'c3', type: 'capture', amt: 300, ts: 5000 },
    { id: 'c2', type: 'capture', amt: 200, ts: 2000 },
  ]);
  assert.equal(w0.cert, expected);
  assert.match(w0.cert, /^[0-9a-f]{64}$/);

  const w1 = finals.find((r) => r.winStart === 300000);
  assert.equal(w1.net, 50);
  assert.equal(w1.mch, 'mB');
});

test('B: void after window close emits correction, history untouched', () => {
  const records = run([
    { type: 'capture', id: 'c1', mch: 'mA', amt: 100, ts: 1000 },
    { type: 'capture', id: 'c2', mch: 'mA', amt: 1, ts: 400000 }, // watermark 397000 closes win 0
    { type: 'void', id: 'c1', ts: 401000 },
  ]);
  const final0 = records.find((r) => r.status === 'final' && r.winStart === 0);
  assert.equal(final0.net, 100); // original record unchanged

  const corr = records.find((r) => r.status === 'correction');
  assert.ok(corr, 'correction record expected');
  assert.equal(corr.winStart, 0);
  assert.equal(corr.winEnd, 300000);
  assert.equal(corr.mch, 'mA');
  assert.equal(corr.net, -100);
  assert.equal(corr.voidOf, 'c1');
  assert.match(corr.cert, /^[0-9a-f]{64}$/);
  // no second final for window 0
  assert.equal(records.filter((r) => r.status === 'final' && r.winStart === 0).length, 1);
});

test('C: duplicate capture id is a CONFLICT and never double-counted', () => {
  const records = run([
    { type: 'capture', id: 'c1', mch: 'mA', amt: 100, ts: 1000 },
    { type: 'capture', id: 'c1', mch: 'mA', amt: 100, ts: 2000 },
    { type: 'capture', id: 'c2', mch: 'mA', amt: 5, ts: 400000 },
  ]);
  const conflict = records.find((r) => r.code === 'CONFLICT');
  assert.ok(conflict);
  assert.equal(conflict.line, 2);
  assert.equal(conflict.id, 'c1');
  const final0 = records.find((r) => r.status === 'final' && r.winStart === 0);
  assert.equal(final0.net, 100); // counted exactly once
});

test('late events beyond watermark are recorded and not settled', () => {
  const records = run([
    { type: 'capture', id: 'c1', mch: 'mA', amt: 10, ts: 400000 },
    { type: 'capture', id: 'c2', mch: 'mA', amt: 20, ts: 1000 }, // late
  ]);
  const late = records.find((r) => r.status === 'late');
  assert.ok(late);
  assert.equal(late.id, 'c2');
  const finals = records.filter((r) => r.status === 'final');
  assert.equal(finals.length, 1);
  assert.equal(finals[0].net, 10);
});

test('data errors: non-integer or negative amt recorded, processing continues', () => {
  const records = run([
    { type: 'capture', id: 'c1', mch: 'mA', amt: 1.5, ts: 1000 },
    { type: 'capture', id: 'c2', mch: 'mA', amt: -5, ts: 1000 },
    { type: 'capture', id: 'c3', mch: 'mA', amt: 70, ts: 1000 },
  ]);
  const errs = records.filter((r) => r.code === 'DATA_ERROR');
  assert.equal(errs.length, 2);
  assert.deepEqual(errs.map((e) => e.line), [1, 2]);
  const final0 = records.find((r) => r.status === 'final');
  assert.equal(final0.net, 70);
});

test('auth entries settle and can be voided like captures', () => {
  const records = run([
    { type: 'auth', id: 'a1', mch: 'mA', amt: 400, ts: 1000 },
    { type: 'capture', id: 'c1', mch: 'mA', amt: 100, ts: 2000 },
    { type: 'void', id: 'a1', ts: 3000 },
    { type: 'capture', id: 'c2', mch: 'mA', amt: 1, ts: 400000 },
  ]);
  const final0 = records.find((r) => r.status === 'final' && r.winStart === 0);
  assert.equal(final0.net, 100);
});

test('CLI: invalid JSON exits 2 with line number', () => {
  const inF = tmpFile(
    'bad.jsonl',
    '{"type":"capture","id":"c1","mch":"mA","amt":1,"ts":1}\nnot-json\n'
  );
  const outF = path.join(path.dirname(inF), 'out.jsonl');
  const args = ['settle', '--in', inF, '--wm', String(WM), '--out', outF];

  const inProc = runCliInProcess(args);
  assert.equal(inProc.code, 2);
  assert.match(inProc.errs.join('\n'), /line 2/);

  const spawned = runCliSpawn(args);
  assert.equal(spawned.status, 2); // exit code propagates to the OS
});

test('CLI: end-to-end output shape', () => {
  const inF = tmpFile(
    'ev.jsonl',
    [
      JSON.stringify({ type: 'capture', id: 'c1', mch: 'mA', amt: 100, ts: 1000 }),
      JSON.stringify({ type: 'capture', id: 'c2', mch: 'mA', amt: 1, ts: 400000 }),
    ].join('\n') + '\n'
  );
  const outF = path.join(path.dirname(inF), 'out.jsonl');
  const r = runCliSpawn(['settle', '--in', inF, '--wm', String(WM), '--out', outF]);
  assert.equal(r.status, 0);
  const rows = fs.readFileSync(outF, 'utf8').trim().split('\n').map(JSON.parse);
  const final0 = rows.find((x) => x.status === 'final' && x.winStart === 0);
  for (const k of ['winStart', 'winEnd', 'mch', 'net', 'cert', 'status']) {
    assert.ok(k in final0, `missing key ${k}`);
  }
  assert.equal(final0.net, 100);
});

test('D: naive full replay matches streaming on randomized <=200-event inputs', () => {
  for (const seed of [1, 7, 42, 1337]) {
    const rand = lcg(seed);
    const events = [];
    const n = 150;
    let maxTs = 0;
    for (let i = 0; i < n; i++) {
      const roll = rand();
      maxTs += Math.floor(rand() * 20000);
      const ts = maxTs - Math.floor(rand() * 2500); // mild out-of-orderness
      if (roll < 0.2 && events.length > 0) {
        const prev = events[Math.floor(rand() * events.length)];
        events.push({ type: 'void', id: prev.id, ts: maxTs });
      } else if (roll < 0.3 && events.length > 0) {
        const prev = events[Math.floor(rand() * events.length)];
        events.push({ type: 'capture', id: prev.id, mch: 'mX', amt: 10, ts }); // duplicate id
      } else {
        events.push({
          type: roll < 0.6 ? 'auth' : 'capture',
          id: `e${seed}-${i}`,
          mch: `m${Math.floor(rand() * 4)}`,
          amt: Math.floor(rand() * 1000),
          ts: Math.max(0, ts),
        });
      }
    }
    const parsed = events.map((ev, i) => ({ ev, lineNo: i + 1 }));
    const s = new Settler({ allowedLatenessMs: WM });
    for (const { ev, lineNo } of parsed) s.process(ev, lineNo);
    const streaming = s.finish();
    const naive = naiveRun(parsed, WM);
    assert.deepEqual(streaming, naive, `seed ${seed} mismatch`);
  }
});

test('D: CLI --naive flag verifies replay and exits 0', () => {
  const rand = lcg(99);
  const events = [];
  let maxTs = 0;
  for (let i = 0; i < 120; i++) {
    maxTs += Math.floor(rand() * 30000);
    events.push(
      JSON.stringify({
        type: rand() < 0.5 ? 'auth' : 'capture',
        id: `e${i}`,
        mch: `m${i % 3}`,
        amt: Math.floor(rand() * 500),
        ts: Math.max(0, maxTs - Math.floor(rand() * 2000)),
      })
    );
  }
  const inF = tmpFile('naive.jsonl', events.join('\n') + '\n');
  const outF = path.join(path.dirname(inF), 'out.jsonl');
  const args = ['settle', '--in', inF, '--wm', String(WM), '--out', outF, '--naive'];

  const inProc = runCliInProcess(args);
  assert.equal(inProc.code, 0);
  assert.match(inProc.errs.join('\n'), /naive replay verified/);

  const spawned = runCliSpawn(args);
  assert.equal(spawned.status, 0);
});

test('cert binds rules version', () => {
  assert.equal(RULES_VERSION, 'settle-v1');
  const c1 = windowCert(0, 300000, 'mA', [{ id: 'x', type: 'capture', amt: 1, ts: 1 }]);
  const c2 = windowCert(0, 300000, 'mA', [{ id: 'x', type: 'capture', amt: 2, ts: 1 }]);
  assert.notEqual(c1, c2);
});
