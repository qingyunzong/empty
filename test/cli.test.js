import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPipeline } from '../src/run.js';

const accountsDoc = {
  accounts: [
    { id: 'low', priority: 1, maintenanceLine: 100, liquidationLine: 50, deadlineSlot: 2, cash: 0, positions: { ES: 1 }, initialMarks: { ES: 60 } },
    { id: 'high', priority: 1, maintenanceLine: 100, liquidationLine: 50, deadlineSlot: 2, cash: 0, positions: { NQ: 1 }, initialMarks: { NQ: 200 } },
    { id: 'safe', priority: 0, maintenanceLine: 100, liquidationLine: 50, deadlineSlot: 2, cash: 500, positions: {} },
  ],
};
const ticksDoc = {
  slots: 1,
  slotCapacity: 1,
  events: [
    { type: 'tick', symbol: 'NQ', version: 1, price: 30 }, // high: equity 30 -> gap 70, preempts
    { type: 'tick', symbol: 'NQ', version: 1, price: 999 }, // stale, rejected
    { type: 'tick', symbol: 'NQ', version: 2, price: 400 }, // erroneous spike, no call needed
    { type: 'undo', symbol: 'NQ', version: 2 }, // rollback to v1 -> replay call
  ],
};

test('pipeline end-to-end: calls, rolledBack, errors and proof', () => {
  const out = runPipeline({ ticksDoc, accountsDoc });

  assert.deepEqual(out.calls.map((c) => [c.accountId, c.slot]), [['high', 0]]);
  assert.deepEqual(out.errors, [
    { code: 'STALE_TICK', symbol: 'NQ', version: 1, currentVersion: 1 },
    { code: 'NO_CAPACITY', accountId: 'low', deadlineSlot: 2 },
  ]);
  assert.deepEqual(out.rolledBack, [
    { symbol: 'NQ', undoneVersion: 2, restoredVersion: 1, affectedAccounts: ['high'], replayed: ['high'] },
  ]);
  assert.equal(typeof out.proof.seed, 'number');
  assert.match(out.proof.scheduleHash, /^[0-9a-f]{64}$/);
  assert.match(out.proof.inputHash, /^[0-9a-f]{64}$/);
  assert.equal(out.proof.fullRecomputeMatch, true);
});

test('pipeline is deterministic: two runs produce identical proof', () => {
  const a = runPipeline({ ticksDoc, accountsDoc });
  const b = runPipeline({ ticksDoc, accountsDoc });
  assert.deepEqual(a, b);
  assert.equal(a.proof.scheduleHash, b.proof.scheduleHash);
  assert.equal(a.proof.seed, b.proof.seed);
});

test('pipeline rejects malformed input', () => {
  assert.throws(() => runPipeline({ ticksDoc: { events: [] }, accountsDoc: { accounts: [] } }));
});
