// Randomized cross-check: the incremental engine must always agree with the
// reference implementation, which independently rescans all log records and
// rebuilds the bitemporal intervals from scratch.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';
import { activeEvents, asOf, dailyCounts, buildIntervals } from '../src/reference.js';

function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BASE = Date.parse('2024-01-01T00:00:00Z');
const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();

test('incremental engine matches full-scan reference on random workloads', () => {
  const rnd = mulberry32(20241003);
  const engine = new Engine();
  const records = [];
  const committedTx = [];
  const equipments = ['eq-a', 'eq-b', 'eq-c'];
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

  for (let op = 0; op < 300; op++) {
    const undoable = committedTx.filter((tx) => !engine.undoneTx.has(tx));
    if (undoable.length > 0 && rnd() < 0.15) {
      const txId = pick(undoable);
      engine.undo(txId);
      records.push({
        kind: 'undo',
        tx_id: `undo-${txId}`,
        undo_tx_id: txId,
        tx_time: iso(BASE + 90 * DAY),
      });
    } else {
      const txId = `tx-${op}`;
      const txMs = BASE + Math.floor(rnd() * 60 * DAY); // deliberately out of order
      const eventCount = 1 + Math.floor(rnd() * 3);
      const events = [];
      for (let i = 0; i < eventCount; i++) {
        events.push({
          id: `${txId}-e${i}`,
          equipment: pick(equipments),
          valid_time: iso(BASE + Math.floor(rnd() * 30 * DAY)),
          state: rnd() < 0.5 ? 'up' : 'down',
          tx_id: txId,
          tx_time: iso(txMs),
        });
      }
      engine.applyBatch({ kind: 'batch', tx_id: txId, tx_time: iso(txMs), events });
      records.push({ kind: 'batch', tx_id: txId, tx_time: iso(txMs), events });
      committedTx.push(txId);
    }

    const scanned = activeEvents(records);
    assert.deepEqual(
      engine.countsSnapshot(),
      dailyCounts(scanned),
      `counts diverged after op ${op}`,
    );
    for (let q = 0; q < 6; q++) {
      const equipment = pick(equipments);
      const validMs = BASE + Math.floor(rnd() * 45 * DAY);
      const txMs = rnd() < 0.5 ? Infinity : BASE + Math.floor(rnd() * 90 * DAY);
      assert.equal(
        engine.asOf(equipment, validMs, txMs),
        asOf(scanned, equipment, validMs, txMs),
        `asOf diverged after op ${op} (eq=${equipment})`,
      );
    }
  }
});

test('historical AS OF views are immutable under later retroactive corrections', () => {
  const rnd = mulberry32(7);
  const engine = new Engine();
  const records = [];
  const frozenQueries = [];

  for (let op = 0; op < 60; op++) {
    const txId = `tx-${op}`;
    const txMs = BASE + op * DAY; // tx_time increases with arrival
    const events = [
      {
        id: `${txId}-e0`,
        equipment: 'eq-x',
        valid_time: iso(BASE + Math.floor(rnd() * 30 * DAY)),
        state: rnd() < 0.5 ? 'up' : 'down',
        tx_id: txId,
        tx_time: iso(txMs),
      },
    ];
    engine.applyBatch({ kind: 'batch', tx_id: txId, tx_time: iso(txMs), events });
    records.push({ kind: 'batch', tx_id: txId, tx_time: iso(txMs), events });

    // Freeze a query whose tx_time horizon is "now"; later corrections must
    // never change its answer.
    const validMs = BASE + Math.floor(rnd() * 30 * DAY);
    frozenQueries.push({
      validMs,
      txMs,
      expected: engine.asOf('eq-x', validMs, txMs),
    });
    for (const q of frozenQueries) {
      assert.equal(
        engine.asOf('eq-x', q.validMs, q.txMs),
        q.expected,
        `historical view changed after op ${op}`,
      );
      assert.equal(engine.asOf('eq-x', q.validMs, q.txMs), asOf(activeEvents(records), 'eq-x', q.validMs, q.txMs));
    }
  }
});

test('reference builds correct bitemporal intervals', () => {
  const records = [
    {
      kind: 'batch',
      tx_id: 't1',
      tx_time: '2024-01-02T00:00:00Z',
      events: [
        { id: 'a', equipment: 'eq', valid_time: '2024-01-01T00:00:00Z', state: 'up', tx_id: 't1', tx_time: '2024-01-02T00:00:00Z' },
        { id: 'b', equipment: 'eq', valid_time: '2024-01-05T00:00:00Z', state: 'down', tx_id: 't1', tx_time: '2024-01-02T00:00:00Z' },
      ],
    },
    {
      kind: 'batch',
      tx_id: 't2',
      tx_time: '2024-01-10T00:00:00Z',
      events: [
        { id: 'c', equipment: 'eq', valid_time: '2024-01-05T00:00:00Z', state: 'up', tx_id: 't2', tx_time: '2024-01-10T00:00:00Z' },
      ],
    },
  ];
  const events = activeEvents(records);
  const day = (d) => Date.parse(`2024-01-0${d}T00:00:00Z`);

  const current = buildIntervals(events, 'eq');
  assert.deepEqual(
    current.map((i) => [i.from, i.to, i.state]),
    [
      [day(1), day(5), 'up'],
      [day(5), Infinity, 'up'],
    ],
  );
  const historical = buildIntervals(events, 'eq', day(2));
  assert.deepEqual(
    historical.map((i) => [i.from, i.to, i.state]),
    [
      [day(1), day(5), 'up'],
      [day(5), Infinity, 'down'],
    ],
  );
});
