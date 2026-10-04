import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Engine } from '../src/engine.js';
import { rebuild } from '../src/reference.js';
import { ValidationError } from '../src/model.js';

function tempLog() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-'));
  return path.join(dir, 'events.log');
}

function batch(txId, txTime, events) {
  return {
    tx_id: txId,
    tx_time: txTime,
    events: events.map(([id, equipment, validTime, state]) => ({
      id,
      equipment,
      valid_time: validTime,
      state,
    })),
  };
}

function countsOf(engine) {
  return Object.fromEntries([...engine.counts.keys()].sort().map((k) => [k, engine.counts.get(k)]));
}

test('commit maintains daily up/down counts and reports deltas', () => {
  const log = tempLog();
  const engine = Engine.load(log);
  const r1 = engine.commit(batch('tx-1', '2024-01-10T00:00:00Z', [
    ['e1', 'pump-1', '2024-01-01T08:00:00Z', 'up'],
    ['e2', 'pump-2', '2024-01-01T09:00:00Z', 'down'],
    ['e3', 'pump-2', '2024-01-03T09:00:00Z', 'up'],
  ]));
  assert.deepEqual(r1.deltas, [
    { date: '2024-01-01', up: 1, down: 1 },
    { date: '2024-01-02', up: 1, down: 1 },
    { date: '2024-01-03', up: 2 },
  ]);
  assert.deepEqual(countsOf(engine), {
    '2024-01-01': { up: 1, down: 1 },
    '2024-01-02': { up: 1, down: 1 },
    '2024-01-03': { up: 2, down: 0 },
  });
  assert.ok(engine.verify());
});

test('scenario 1: retroactive valid_time correction changes current view, not historical AS OF', () => {
  const log = tempLog();
  const engine = Engine.load(log);
  engine.commit(batch('tx-1', '2024-01-10T00:00:00Z', [
    ['e1', 'pump-1', '2024-01-01T08:00:00Z', 'up'],
  ]));
  const hashBefore = engine.hash();

  const asOfBefore = engine.asOf(Date.parse('2024-01-15T00:00:00Z'));
  assert.equal(asOfBefore.stateAt('pump-1', Date.parse('2024-01-05T00:00:00Z')), 'up');

  const r2 = engine.commit(batch('tx-2', '2024-01-20T00:00:00Z', [
    ['e2', 'pump-1', '2024-01-01T12:00:00Z', 'down'],
  ]));
  assert.deepEqual(r2.deltas, [{ date: '2024-01-01', up: -1, down: 1 }]);

  // Current view reflects the correction.
  assert.equal(engine.stateAt('pump-1', Date.parse('2024-01-05T00:00:00Z')), 'down');
  assert.notEqual(engine.hash(), hashBefore);

  // Historical AS OF tx_time view is untouched by the later correction.
  const asOfAfter = engine.asOf(Date.parse('2024-01-15T00:00:00Z'));
  assert.equal(asOfAfter.stateAt('pump-1', Date.parse('2024-01-05T00:00:00Z')), 'up');
  assert.deepEqual(asOfAfter.counts.get('2024-01-01'), { up: 1, down: 0 });
  assert.ok(engine.verify());
});

test('scenario 2: out-of-order tx_time is visible by transaction time, not arrival order', () => {
  const log = tempLog();
  const engine = Engine.load(log);
  // Later tx_time arrives first.
  engine.commit(batch('tx-a', '2024-02-10T10:00:00Z', [
    ['e1', 'pump-2', '2024-02-01T09:00:00Z', 'down'],
  ]));
  // Earlier tx_time arrives second.
  engine.commit(batch('tx-b', '2024-02-05T10:00:00Z', [
    ['e2', 'pump-2', '2024-02-01T09:00:00Z', 'up'],
  ]));

  const t = Date.parse('2024-02-03T00:00:00Z');
  // Current view: greatest tx_time wins, regardless of arrival order.
  assert.equal(engine.stateAt('pump-2', t), 'down');
  // AS OF between the two tx_times: only tx-b visible.
  assert.equal(engine.asOf(Date.parse('2024-02-07T00:00:00Z')).stateAt('pump-2', t), 'up');
  // AS OF before both: nothing known.
  assert.equal(engine.asOf(Date.parse('2024-02-04T00:00:00Z')).stateAt('pump-2', t), null);
  assert.ok(engine.verify());
});

test('scenario 3: invalid batch is rejected atomically; counts and hash unchanged', () => {
  const log = tempLog();
  const engine = Engine.load(log);
  engine.commit(batch('tx-1', '2024-01-10T00:00:00Z', [
    ['e1', 'pump-1', '2024-01-01T08:00:00Z', 'up'],
  ]));
  const hashBefore = engine.hash();
  const countsBefore = countsOf(engine);
  const logBefore = fs.readFileSync(log, 'utf8');

  const badBatches = [
    batch('tx-2', '2024-01-11T00:00:00Z', [
      ['e2', 'pump-1', '2024-01-02T00:00:00Z', 'up'],
      ['e3', 'pump-2', '2024-01-02T00:00:00Z', 'sideways'],
    ]),
    batch('tx-3', '2024-01-11T00:00:00Z', [
      ['e4', 'pump-1', 'not-a-time', 'down'],
    ]),
    batch('tx-4', 'not-a-time', [['e5', 'pump-1', '2024-01-02T00:00:00Z', 'up']]),
    { tx_id: '', tx_time: '2024-01-11T00:00:00Z', events: [{ id: 'e6', equipment: 'p', valid_time: '2024-01-02T00:00:00Z', state: 'up' }] },
    { tx_id: 'tx-5', tx_time: '2024-01-11T00:00:00Z', events: [] },
    { tx_id: 'tx-6', tx_time: '2024-01-11T00:00:00Z', events: [{ id: 'e7', valid_time: '2024-01-02T00:00:00Z', state: 'up' }] },
  ];
  for (const bad of badBatches) {
    assert.throws(() => engine.commit(bad), ValidationError);
  }
  // Duplicate tx_id is also rejected.
  assert.throws(
    () => engine.commit(batch('tx-1', '2024-01-12T00:00:00Z', [['e8', 'p', '2024-01-02T00:00:00Z', 'up']])),
    ValidationError,
  );

  assert.equal(engine.hash(), hashBefore);
  assert.deepEqual(countsOf(engine), countsBefore);
  assert.equal(fs.readFileSync(log, 'utf8'), logBefore);
  assert.ok(engine.verify());
});

test('undo by tx_id maintains both snapshot and deltas; AS OF between commit and revert still sees it', () => {
  const log = tempLog();
  const engine = Engine.load(log);
  engine.commit(batch('tx-1', '2024-01-10T00:00:00Z', [
    ['e1', 'pump-1', '2024-01-01T08:00:00Z', 'up'],
  ]));
  const hashAfterTx1 = engine.hash();
  engine.commit(batch('tx-2', '2024-01-11T00:00:00Z', [
    ['e2', 'pump-1', '2024-01-02T08:00:00Z', 'down'],
  ]));
  assert.deepEqual(countsOf(engine), {
    '2024-01-01': { up: 1, down: 0 },
    '2024-01-02': { up: 0, down: 1 },
  });

  const result = engine.revert('tx-2', '2024-01-12T00:00:00Z');
  // Day 2024-01-02 leaves the maintained range once tx-2 is reverted.
  assert.deepEqual(result.deltas, [{ date: '2024-01-02', down: -1 }]);
  assert.deepEqual(countsOf(engine), {
    '2024-01-01': { up: 1, down: 0 },
  });
  // Undo restores the exact snapshot/hash as if tx-2 had never happened.
  assert.equal(engine.hash(), hashAfterTx1);

  // Between commit and revert tx_times, tx-2 is still visible.
  const during = engine.asOf(Date.parse('2024-01-11T12:00:00Z'));
  assert.equal(during.stateAt('pump-1', Date.parse('2024-01-02T12:00:00Z')), 'down');
  // After the revert, it is not.
  assert.equal(engine.stateAt('pump-1', Date.parse('2024-01-02T12:00:00Z')), 'up');

  assert.throws(() => engine.revert('tx-2', '2024-01-13T00:00:00Z'), ValidationError);
  assert.throws(() => engine.revert('tx-nope', '2024-01-13T00:00:00Z'), ValidationError);
  assert.ok(engine.verify());
});

test('crash after append is healed by replay; crash before append leaves no trace', () => {
  const log = tempLog();
  const engine = Engine.load(log);
  engine.commit(batch('tx-1', '2024-01-10T00:00:00Z', [
    ['e1', 'pump-1', '2024-01-01T08:00:00Z', 'up'],
  ]));
  engine.commit(batch('tx-2', '2024-01-11T00:00:00Z', [
    ['e2', 'pump-1', '2024-01-01T12:00:00Z', 'down'],
  ]));
  engine.revert('tx-2', '2024-01-12T00:00:00Z');

  // Restart: replaying the log reproduces the exact snapshot.
  const recovered = Engine.load(log);
  assert.equal(recovered.hash(), engine.hash());
  assert.deepEqual(countsOf(recovered), countsOf(engine));
  assert.ok(recovered.verify());

  // Torn final line (crash mid-append) is ignored on recovery.
  fs.appendFileSync(log, '{"type":"commit","tx_id":"tx-3","tx_time":"2024-01-13');
  const recovered2 = Engine.load(log);
  assert.equal(recovered2.hash(), engine.hash());
  assert.deepEqual(countsOf(recovered2), countsOf(engine));
});

test('randomized property: incremental engine matches independent full rebuild', () => {
  // Deterministic PRNG (mulberry32).
  let seed = 0xC0FFEE;
  const rand = () => {
    seed |= 0;
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];

  const log = tempLog();
  const engine = Engine.load(log);
  const equipment = ['pump-1', 'pump-2', 'valve-1'];
  const base = Date.parse('2024-01-01T00:00:00Z');
  const committed = [];
  let txCounter = 0;
  let eventCounter = 0;

  for (let op = 0; op < 60; op += 1) {
    if (committed.length > 0 && rand() < 0.2) {
      const txId = pick(committed);
      committed.splice(committed.indexOf(txId), 1);
      const revertTime = base + Math.floor(rand() * 40) * 3_600_000;
      engine.revert(txId, new Date(revertTime).toISOString());
    } else {
      txCounter += 1;
      const txId = `tx-${txCounter}`;
      const txTime = base + Math.floor(rand() * 40) * 3_600_000;
      const events = [];
      const n = 1 + Math.floor(rand() * 3);
      for (let i = 0; i < n; i += 1) {
        eventCounter += 1;
        events.push([
          `e${eventCounter}`,
          pick(equipment),
          new Date(base + Math.floor(rand() * 20) * 3_600_000).toISOString(),
          pick(['up', 'down']),
        ]);
      }
      engine.commit(batch(txId, new Date(txTime).toISOString(), events));
      committed.push(txId);
    }
    const reference = rebuild(engine.entries);
    assert.deepEqual(countsOf(engine), Object.fromEntries(reference.counts), `mismatch after op ${op}`);
    assert.ok(engine.verify(), `verify failed after op ${op}`);
    // Random historical AS OF views must be consistent too.
    const asOfMs = base + Math.floor(rand() * 45) * 3_600_000;
    const historical = engine.asOf(asOfMs);
    const eq = pick(equipment);
    const t = base + Math.floor(rand() * 25) * 3_600_000;
    assert.equal(historical.stateAt(eq, t), rebuild(engine.entries, asOfMs).stateAt(eq, t));
  }

  // Recovery from the log reproduces the same state.
  const recovered = Engine.load(log);
  assert.equal(recovered.hash(), engine.hash());
  assert.deepEqual(countsOf(recovered), countsOf(engine));
});
