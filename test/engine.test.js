import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RiskEngine, runEngine } from '../src/engine.js';
import { fullRecompute } from '../src/full-recompute.js';

const baseAccounts = [
  { id: 'A1', priority: 1, liquidationLine: 1000, deadlineSlot: 3, cash: 0, position: 10 },
  { id: 'A2', priority: 1, liquidationLine: 1000, deadlineSlot: 3, cash: 0, position: 10 },
];

test('rejects out-of-order tick with STALE_TICK and keeps higher version', () => {
  const engine = new RiskEngine(baseAccounts, { slots: 4 });
  assert.equal(engine.applyTick({ accountId: 'A1', price: 120, version: 5 }).ok, true);
  const res = engine.applyTick({ accountId: 'A1', price: 50, version: 3 });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'STALE_TICK');
  assert.equal(engine.account('A1').price, 120);
  assert.equal(engine.account('A1').head, 5);
  assert.deepEqual(engine.errors, [{ code: 'STALE_TICK', accountId: 'A1', version: 3 }]);
});

test('undo of head version rolls back to highest valid lower version and replays call', () => {
  const events = [
    { accountId: 'A1', price: 90, version: 1 }, // equity 900 -> gap 100
    { accountId: 'A1', price: 80, version: 2 }, // equity 800 -> gap 200
    { op: 'undo', accountId: 'A1', version: 2 }, // restore v1
  ];
  const result = runEngine(baseAccounts, events, { slots: 4 });
  assert.deepEqual(result.rolledBack, [{ accountId: 'A1', fromVersion: 2, toVersion: 1 }]);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].accountId, 'A1');
  assert.equal(result.calls[0].version, 1);
  assert.equal(result.calls[0].gap, 100);
  assert.equal(result.errors.length, 0);
});

test('undo of last remaining version clears the margin call', () => {
  const events = [
    { accountId: 'A1', price: 80, version: 1 },
    { op: 'undo', accountId: 'A1', version: 1 },
  ];
  const result = runEngine(baseAccounts, events, { slots: 4 });
  assert.deepEqual(result.rolledBack, [{ accountId: 'A1', fromVersion: 1, toVersion: null }]);
  assert.equal(result.calls.length, 0);
});

test('undo of unknown version yields UNDO_GAP', () => {
  const engine = new RiskEngine(baseAccounts, { slots: 4 });
  engine.applyTick({ accountId: 'A1', price: 100, version: 1 });
  const res = engine.applyUndo({ accountId: 'A1', version: 7 });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'UNDO_GAP');
  assert.deepEqual(engine.errors, [{ code: 'UNDO_GAP', accountId: 'A1', version: 7 }]);
});

test('tick driving equity negative is rejected with NEGATIVE_EQUITY', () => {
  const engine = new RiskEngine(baseAccounts, { slots: 4 });
  const res = engine.applyTick({ accountId: 'A1', price: -5, version: 1 });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'NEGATIVE_EQUITY');
  assert.equal(engine.account('A1').head, null);
  assert.deepEqual(engine.errors, [
    { code: 'NEGATIVE_EQUITY', accountId: 'A1', version: 1, equity: -50 },
  ]);
});

test('full slot: higher-gap account preempts lower-gap account', () => {
  const accounts = [
    { id: 'LOW', priority: 1, liquidationLine: 1000, deadlineSlot: 1, cash: 0, position: 10 },
    { id: 'HIGH', priority: 1, liquidationLine: 1000, deadlineSlot: 1, cash: 0, position: 10 },
  ];
  const events = [
    { accountId: 'LOW', price: 95, version: 1 }, // gap 50
    { accountId: 'HIGH', price: 70, version: 1 }, // gap 300
  ];
  const result = runEngine(accounts, events, { slots: 1, slotCapacity: 1 });
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].accountId, 'HIGH');
  assert.equal(result.calls[0].slot, 1);
  assert.deepEqual(result.errors, [{ code: 'NO_CAPACITY', accountId: 'LOW', preemptedBy: 'HIGH' }]);
});

test('priority dominates gap; ties break by gap, liquidation distance, account id', () => {
  const accounts = [
    { id: 'P1_BIGGAP', priority: 1, liquidationLine: 1000, deadlineSlot: 1, cash: 0, position: 10 },
    { id: 'P2_SMALLGAP', priority: 2, liquidationLine: 1000, deadlineSlot: 1, cash: 0, position: 10 },
  ];
  const events = [
    { accountId: 'P1_BIGGAP', price: 50, version: 1 }, // gap 500
    { accountId: 'P2_SMALLGAP', price: 99, version: 1 }, // gap 10
  ];
  const result = runEngine(accounts, events, { slots: 1, slotCapacity: 1 });
  assert.equal(result.calls[0].accountId, 'P2_SMALLGAP'); // higher priority wins despite smaller gap
  assert.deepEqual(result.errors, [{ code: 'NO_CAPACITY', accountId: 'P1_BIGGAP', preemptedBy: 'P2_SMALLGAP' }]);
});

test('deadline is respected: task past its deadline slot gets NO_CAPACITY', () => {
  const accounts = [
    { id: 'A1', priority: 1, liquidationLine: 1000, deadlineSlot: 1, cash: 0, position: 10 },
    { id: 'A2', priority: 1, liquidationLine: 1000, deadlineSlot: 2, cash: 0, position: 10 },
  ];
  const events = [
    { accountId: 'A1', price: 90, version: 1 },
    { accountId: 'A2', price: 90, version: 1 },
  ];
  const result = runEngine(accounts, events, { slots: 2, slotCapacity: 1 });
  assert.equal(result.calls.length, 2);
  assert.deepEqual(result.calls.map((c) => [c.accountId, c.slot]), [['A1', 1], ['A2', 2]]);
});

test('output is deterministic: identical seed and scheduleHash across runs', () => {
  const events = [
    { accountId: 'A1', price: 90, version: 1 },
    { accountId: 'A2', price: 85, version: 1 },
    { accountId: 'A1', price: 70, version: 2 },
    { op: 'undo', accountId: 'A1', version: 2 },
  ];
  const r1 = runEngine(baseAccounts, events, { slots: 2 });
  const r2 = runEngine(baseAccounts, events, { slots: 2 });
  assert.equal(r1.proof.seed, r2.proof.seed);
  assert.equal(r1.proof.scheduleHash, r2.proof.scheduleHash);
  assert.match(r1.proof.seed, /^[0-9a-f]{16}$/);
  assert.match(r1.proof.scheduleHash, /^[0-9a-f]{64}$/);
});

// Seeded PRNG for reproducible randomized scenarios.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('n<=8: incremental engine matches independent full recompute on randomized scenarios', () => {
  const rand = mulberry32(0xC0FFEE);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  for (let scenario = 0; scenario < 300; scenario++) {
    const n = 1 + Math.floor(rand() * 8); // 1..8 accounts
    const accounts = [];
    for (let i = 0; i < n; i++) {
      accounts.push({
        id: `AC${i}`,
        priority: 1 + Math.floor(rand() * 3),
        liquidationLine: 500 + Math.floor(rand() * 1000),
        deadlineSlot: 1 + Math.floor(rand() * 4),
        cash: Math.floor(rand() * 200),
        position: 1 + Math.floor(rand() * 20),
      });
    }
    const eventCount = 1 + Math.floor(rand() * 30);
    const events = [];
    for (let e = 0; e < eventCount; e++) {
      const accountId = pick(accounts).id;
      if (rand() < 0.3) {
        events.push({ op: 'undo', accountId, version: 1 + Math.floor(rand() * 12) });
      } else {
        events.push({
          accountId,
          price: 20 + Math.floor(rand() * 120),
          version: 1 + Math.floor(rand() * 12),
        });
      }
    }
    const config = { slots: 1 + Math.floor(rand() * 4), slotCapacity: 1 + Math.floor(rand() * 2) };
    const inc = runEngine(accounts, events, config);
    const full = fullRecompute(accounts, events, config);
    assert.deepEqual(inc.calls, full.calls, `calls diverge in scenario ${scenario}`);
    assert.deepEqual(inc.rolledBack, full.rolledBack, `rolledBack diverge in scenario ${scenario}`);
    assert.deepEqual(inc.errors, full.errors, `errors diverge in scenario ${scenario}`);
    assert.equal(inc.proof.scheduleHash, full.proof.scheduleHash, `hash diverge in scenario ${scenario}`);
  }
});
