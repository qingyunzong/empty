'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runOps, mulberry32 } = require('../scheduler');
const { execute } = require('../cli');

function runCli(ops, args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-'));
  const file = path.join(dir, 'ops.json');
  fs.writeFileSync(file, JSON.stringify(ops));
  return execute([process.execPath, 'cli.js', file, ...args]);
}

test('acceptance 1: lost ACK retransmit does not double-charge budget', () => {
  const r = runOps(
    [{ type: 'PLAN', id: 'a', ver: 1, start: 0, cost: 30, loseAck: 2 }],
    { cap: 100, seed: 7, lossRate: 0 }
  );
  assert.equal(r.exitCode, 0);
  assert.equal(r.ledger.filter((e) => e.id === 'a').length, 1, 'exactly one ledger charge');
  assert.equal(r.usage[0], 30, 'budget charged once');
  assert.equal(r.plan.length, 1);
  assert.deepEqual(
    r.retransmissions.map((x) => x.delay),
    [100, 200],
    'exponential backoff delays'
  );
  assert.deepEqual(
    r.retransmissions.map((x) => x.reason),
    ['ack-lost', 'ack-lost']
  );
  assert.equal(r.confirmed[0].dup, true, 'final confirmation came from a deduped retransmit');
});

test('duplicate op in stream is deduped, conflicting reuse of id+ver is a protocol error', () => {
  const ok = runOps(
    [
      { type: 'PLAN', id: 'a', ver: 1, start: 0, cost: 30 },
      { type: 'PLAN', id: 'a', ver: 1, start: 0, cost: 30 },
    ],
    { cap: 100, seed: 1, lossRate: 0 }
  );
  assert.equal(ok.exitCode, 0);
  assert.equal(ok.ledger.length, 1);
  assert.equal(ok.usage[0], 30);

  const bad = runOps(
    [
      { type: 'PLAN', id: 'a', ver: 1, start: 0, cost: 30 },
      { type: 'PLAN', id: 'a', ver: 1, start: 0, cost: 31 },
    ],
    { cap: 100, seed: 1, lossRate: 0 }
  );
  assert.equal(bad.exitCode, 3);
  assert.equal(bad.usage[0], 30, 'state from before the protocol error is preserved');
});

test('acceptance 2: MOVE exceeding budget keeps old occupancy; state unchanged', () => {
  const r = runOps(
    [
      { type: 'PLAN', id: 'a', ver: 1, start: 0, cost: 60 },
      { type: 'PLAN', id: 'b', ver: 1, start: 1, cost: 50 },
      { type: 'MOVE', id: 'a', ver: 2, start: 1 },
    ],
    { cap: 100, seed: 1, lossRate: 0 }
  );
  assert.equal(r.exitCode, 5);
  const a = r.plan.find((p) => p.id === 'a');
  assert.equal(a.start, 0, 'old position retained');
  assert.equal(a.cost, 60);
  assert.equal(r.usage[0], 60);
  assert.equal(r.usage[1], 50);
  assert.equal(r.ledger.filter((e) => e.op.startsWith('MOVE')).length, 0, 'no partial MOVE in ledger');
});

test('MOVE is atomic release+occupy; same-day cost increase over cap is rejected', () => {
  const moved = runOps(
    [
      { type: 'PLAN', id: 'a', ver: 1, start: 0, cost: 60 },
      { type: 'MOVE', id: 'a', ver: 2, start: 2 },
    ],
    { cap: 100, seed: 1, lossRate: 0 }
  );
  assert.equal(moved.exitCode, 0);
  assert.deepEqual(
    moved.ledger.map((e) => [e.op, e.day, e.delta]),
    [
      ['PLAN', 0, 60],
      ['MOVE-RELEASE', 0, -60],
      ['MOVE-OCCUPY', 2, 60],
    ]
  );
  assert.equal(moved.usage[0], undefined);
  assert.equal(moved.usage[2], 60);

  const grown = runOps(
    [
      { type: 'PLAN', id: 'a', ver: 1, start: 0, cost: 60 },
      { type: 'MOVE', id: 'a', ver: 2, start: 0, cost: 120 },
    ],
    { cap: 100, seed: 1, lossRate: 0 }
  );
  assert.equal(grown.exitCode, 5);
  assert.equal(grown.plan[0].cost, 60, 'old cost retained');
  assert.equal(grown.usage[0], 60);
});

test('acceptance 3: nested pending transactions roll back level by level', () => {
  const inner = runOps(
    [
      { type: 'PLAN', id: 'base', ver: 1, start: 0, cost: 10 },
      { type: 'BEGIN' },
      { type: 'PLAN', id: 'x', ver: 1, start: 1, cost: 5, loseSend: 99 },
      { type: 'BEGIN' },
      { type: 'PLAN', id: 'y', ver: 1, start: 2, cost: 5, loseSend: 99 },
      { type: 'ROLLBACK' },
    ],
    { cap: 100, seed: 1, lossRate: 0 }
  );
  assert.equal(inner.exitCode, 0);
  assert.deepEqual(inner.rolledBack.map((p) => p.id), ['y'], 'innermost level rolled back');
  assert.deepEqual(inner.pending.map((p) => p.id), ['x'], 'outer level still pending');

  const all = runOps(
    [
      { type: 'PLAN', id: 'base', ver: 1, start: 0, cost: 10 },
      { type: 'BEGIN' },
      { type: 'PLAN', id: 'x', ver: 1, start: 1, cost: 5, loseSend: 99 },
      { type: 'BEGIN' },
      { type: 'PLAN', id: 'y', ver: 1, start: 2, cost: 5, loseSend: 99 },
      { type: 'ROLLBACK' },
      { type: 'ROLLBACK' },
      { type: 'ROLLBACK' },
    ],
    { cap: 100, seed: 1, lossRate: 0 }
  );
  assert.deepEqual(all.rolledBack.map((p) => p.id), ['y', 'x']);
  assert.equal(all.pending.length, 0);
  assert.equal(all.exitCode, 3, 'ROLLBACK without an open transaction is a protocol error');
});

test('rollback keeps ACKed history and undoes only unconfirmed work', () => {
  const r = runOps(
    [
      { type: 'BEGIN' },
      { type: 'PLAN', id: 'a', ver: 1, start: 0, cost: 10 },
      { type: 'PLAN', id: 'b', ver: 1, start: 1, cost: 5, loseSend: 99 },
      { type: 'ROLLBACK' },
    ],
    { cap: 100, seed: 1, lossRate: 0 }
  );
  assert.equal(r.exitCode, 0);
  assert.deepEqual(r.keptAcked.map((k) => k.id), ['a'], 'ACKed history is kept');
  assert.deepEqual(r.rolledBack.map((k) => k.id), ['b']);
  assert.deepEqual(r.plan.map((p) => p.id), ['a']);
  assert.equal(r.usage[0], 10);
  assert.equal(r.pending.length, 0);
});

test('rollback of delivered-but-unconfirmed command compensates at the terminal', () => {
  const r = runOps(
    [
      { type: 'BEGIN' },
      { type: 'PLAN', id: 'c', ver: 1, start: 0, cost: 20, loseAck: 99 },
      { type: 'ROLLBACK' },
    ],
    { cap: 100, seed: 1, lossRate: 0 }
  );
  assert.equal(r.exitCode, 0);
  assert.equal(r.plan.length, 0);
  assert.deepEqual(r.usage, {});
  assert.deepEqual(
    r.ledger.map((e) => [e.op, e.delta, e.rollback === true]),
    [
      ['PLAN', 20, false],
      ['CANCEL', -20, true],
    ]
  );
});

test('stale (lower) versions are ignored; unknown id is a protocol error', () => {
  const stale = runOps(
    [
      { type: 'PLAN', id: 'a', ver: 1, start: 0, cost: 10 },
      { type: 'MOVE', id: 'a', ver: 2, start: 1 },
      { type: 'CANCEL', id: 'a', ver: 1 },
    ],
    { cap: 100, seed: 1, lossRate: 0 }
  );
  assert.equal(stale.exitCode, 0);
  assert.equal(stale.ignored.length, 1);
  assert.equal(stale.ignored[0].reason, 'stale-version');
  assert.equal(stale.plan[0].start, 1, 'stale CANCEL did not apply');

  const unknown = runOps([{ type: 'MOVE', id: 'ghost', ver: 1, start: 0 }], {
    cap: 100,
    seed: 1,
    lossRate: 0,
  });
  assert.equal(unknown.exitCode, 3);
});

test('plan output is ordered by (start, id) lexicographically', () => {
  const r = runOps(
    [
      { type: 'PLAN', id: 'b', ver: 1, start: 0, cost: 5 },
      { type: 'PLAN', id: 'a', ver: 1, start: 0, cost: 5 },
      { type: 'PLAN', id: 'c', ver: 1, start: 1, cost: 5 },
    ],
    { cap: 100, seed: 1, lossRate: 0 }
  );
  assert.deepEqual(r.plan.map((p) => p.id), ['a', 'b', 'c']);
});

test('acceptance 4: random small runs cross-checked against exhaustive ledger replay', () => {
  const ids = ['a', 'b', 'c', 'd'];
  for (let seed = 1; seed <= 40; seed += 1) {
    const rand = mulberry32(seed);
    const lastVer = new Map();
    const alive = new Set();
    const ops = [];
    for (let n = 0; n < 12; n += 1) {
      const id = ids[Math.floor(rand() * ids.length)];
      const ver = (lastVer.get(id) || 0) + 1;
      const pick = rand();
      if (!alive.has(id)) {
        ops.push({ type: 'PLAN', id, ver, start: Math.floor(rand() * 4), cost: 5 + Math.floor(rand() * 11) });
        alive.add(id);
      } else if (pick < 0.7) {
        const op = { type: 'MOVE', id, ver, start: Math.floor(rand() * 4) };
        if (rand() < 0.5) op.cost = 5 + Math.floor(rand() * 11);
        ops.push(op);
      } else {
        ops.push({ type: 'CANCEL', id, ver });
        alive.delete(id);
      }
      lastVer.set(id, ver);
    }
    const cap = 100;
    const r = runOps(ops, { cap, seed: seed * 1000, lossRate: 0.3, maxAttempts: 10 });
    assert.notEqual(r.exitCode, 3, `seed ${seed}: generator must not produce protocol errors`);

    // Exhaustive replay of the budget ledger: usage matches at every prefix.
    const usage = {};
    for (const e of r.ledger) {
      usage[e.day] = (usage[e.day] || 0) + e.delta;
      assert.ok(usage[e.day] >= 0, `seed ${seed}: negative usage on day ${e.day}`);
      assert.ok(usage[e.day] <= cap, `seed ${seed}: cap exceeded on day ${e.day}`);
      assert.equal(e.used, usage[e.day], `seed ${seed}: ledger entry ${e.seq} usage mismatch`);
    }
    for (const [day, used] of Object.entries(usage)) {
      if (used > 0) assert.equal(r.usage[day], used, `seed ${seed}: reported usage mismatch`);
    }
    // Plan cost sums per day equal reported usage.
    const sums = {};
    for (const p of r.plan) sums[p.start] = (sums[p.start] || 0) + p.cost;
    assert.deepEqual(
      Object.fromEntries(Object.entries(sums).sort((a, b) => a[0] - b[0])),
      Object.fromEntries(Object.entries(r.usage).sort((a, b) => a[0] - b[0])),
      `seed ${seed}: plan sums must equal usage`
    );
    // Pending commands were never confirmed, so they hold no budget.
    for (const p of r.pending) {
      assert.ok(!r.plan.some((x) => x.id === p.id && x.ver === p.ver && !p.delivered));
    }
  }
});

test('CLI: success, budget failure (exit 5) and protocol error (exit 3)', () => {
  const ok = runCli(
    [
      { type: 'PLAN', id: 'job-a', ver: 1, start: 0, cost: 40 },
      { type: 'PLAN', id: 'job-b', ver: 1, start: 0, cost: 30, loseAck: 1 },
    ],
    ['--cap', '100', '--seed', '7']
  );
  assert.equal(ok.exitCode, 0, ok.stderr);
  const out = JSON.parse(ok.stdout);
  assert.equal(out.exitCode, 0);
  assert.equal(out.usage[0], 70);
  assert.equal(out.ledger.length, 2, 'retransmitted ACK did not double-charge');

  const over = runCli(
    [
      { type: 'PLAN', id: 'a', ver: 1, start: 0, cost: 70 },
      { type: 'PLAN', id: 'b', ver: 1, start: 0, cost: 50 },
    ],
    ['--cap', '100', '--seed', '7']
  );
  assert.equal(over.exitCode, 5);
  const overOut = JSON.parse(over.stdout);
  assert.equal(overOut.usage[0], 70, 'failed PLAN left state unchanged');
  assert.equal(overOut.plan.length, 1);

  const bad = runCli([{ type: 'MOVE', id: 'ghost', ver: 1, start: 0 }], ['--cap', '100', '--seed', '7']);
  assert.equal(bad.exitCode, 3);
});
