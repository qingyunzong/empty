import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MarginEngine } from '../src/engine.js';

const baseAccount = {
  priority: 1,
  maintenanceLine: 100,
  liquidationLine: 50,
  deadlineSlot: 2,
  cash: 0,
};

function makeEngine(accounts, config = { slots: 4, slotCapacity: 1 }) {
  const engine = new MarginEngine(config);
  for (const a of accounts) engine.addAccount(a);
  return engine;
}

test('rejects out-of-order ticks with STALE_TICK and keeps the higher version', () => {
  const engine = makeEngine([{ ...baseAccount, id: 'A', positions: { ES: 1 } }]);
  assert.equal(engine.applyTick({ symbol: 'ES', version: 5, price: 90 }).applied, true);
  const stale = engine.applyTick({ symbol: 'ES', version: 3, price: 10 });
  assert.equal(stale.applied, false);
  assert.deepEqual(engine.errors, [{ code: 'STALE_TICK', symbol: 'ES', version: 3, currentVersion: 5 }]);
  assert.equal(engine.equityCache.get('A'), 90); // low version must not overwrite high version
  const equal = engine.applyTick({ symbol: 'ES', version: 5, price: 1 });
  assert.equal(equal.applied, false);
  assert.equal(engine.errors.at(-1).code, 'STALE_TICK');
});

test('undo of top version restores highest valid lower version and replays calls', () => {
  const engine = makeEngine([{ ...baseAccount, id: 'A', positions: { ES: 1 } }]);
  engine.applyTick({ symbol: 'ES', version: 1, price: 120 }); // equity 120, no call
  engine.applyTick({ symbol: 'ES', version: 2, price: 70 }); // equity 70, gap 30
  let result = engine.finalize();
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].gap, 30);

  const undo = engine.undoTick('ES', 2);
  assert.equal(undo.ok, true);
  assert.deepEqual(undo.rolledBack, {
    symbol: 'ES',
    undoneVersion: 2,
    restoredVersion: 1,
    affectedAccounts: ['A'],
    replayed: [], // equity back to 120 -> no call to replay
  });
  assert.equal(engine.equityCache.get('A'), 120);
  result = engine.finalize();
  assert.equal(result.calls.length, 0);
  assert.equal(result.rolledBack.length, 1);
});

test('undo replay re-emits margin call when rollback restores a losing price', () => {
  const engine = makeEngine([{ ...baseAccount, id: 'A', positions: { ES: 1 } }]);
  engine.applyTick({ symbol: 'ES', version: 1, price: 60 }); // gap 40
  engine.applyTick({ symbol: 'ES', version: 2, price: 150 }); // healthy
  assert.equal(engine.finalize().calls.length, 0);
  const undo = engine.undoTick('ES', 2); // roll back to the losing v1 price
  assert.deepEqual(undo.rolledBack.replayed, ['A']);
  const result = engine.finalize();
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].gap, 40);
});

test('undo of a non-top or unknown version fails with UNDO_GAP', () => {
  const engine = makeEngine([{ ...baseAccount, id: 'A', positions: { ES: 1 } }]);
  engine.applyTick({ symbol: 'ES', version: 1, price: 120 });
  engine.applyTick({ symbol: 'ES', version: 2, price: 110 });
  assert.equal(engine.undoTick('ES', 1).ok, false); // would leave a gap
  assert.equal(engine.errors.at(-1).code, 'UNDO_GAP');
  assert.equal(engine.undoTick('ES', 9).ok, false); // unknown version
  assert.equal(engine.errors.at(-1).code, 'UNDO_GAP');
  assert.equal(engine.undoTick('ZZ', 1).ok, false); // unknown symbol
  assert.equal(engine.errors.at(-1).code, 'UNDO_GAP');
  assert.equal(engine.equityCache.get('A'), 110); // state untouched
});

test('negative equity is reported as NEGATIVE_EQUITY and excluded from scheduling', () => {
  const engine = makeEngine([{ ...baseAccount, id: 'A', positions: { ES: 1 } }]);
  engine.applyTick({ symbol: 'ES', version: 1, price: -20 });
  const result = engine.finalize();
  assert.equal(result.calls.length, 0);
  assert.deepEqual(result.errors, [{ code: 'NEGATIVE_EQUITY', accountId: 'A', equity: -20 }]);
  // recovery clears the negative state and re-enables scheduling
  engine.applyTick({ symbol: 'ES', version: 2, price: 80 });
  const recovered = engine.finalize();
  assert.equal(recovered.calls.length, 1);
  assert.equal(recovered.errors.filter((e) => e.code === 'NEGATIVE_EQUITY').length, 1); // logged once
});

test('incremental correction only recomputes affected accounts', () => {
  const engine = makeEngine([
    { ...baseAccount, id: 'A', positions: { ES: 1 } },
    { ...baseAccount, id: 'B', positions: { NQ: 1 } },
    { ...baseAccount, id: 'C', positions: { ES: 2, NQ: 1 } },
  ]);
  const before = engine.stats.recomputes; // 3 from addAccount
  const res = engine.applyTick({ symbol: 'ES', version: 1, price: 95 });
  assert.deepEqual(res.affected, ['A', 'C']);
  assert.equal(engine.stats.recomputes - before, 2); // B untouched
});

test('full slots: higher-gap account preempts lower-gap account after correction', () => {
  const engine = makeEngine(
    [
      { ...baseAccount, id: 'low', positions: { ES: 1 }, initialMarks: { ES: 60 } }, // gap 40
      { ...baseAccount, id: 'high', positions: { NQ: 1 }, initialMarks: { NQ: 200 } }, // healthy
    ],
    { slots: 1, slotCapacity: 1 },
  );
  let result = engine.finalize();
  assert.deepEqual(result.calls.map((c) => c.accountId), ['low']);

  // correction tick makes 'high' gap 70 > 40 -> preempts the only slot
  engine.applyTick({ symbol: 'NQ', version: 1, price: 30 });
  result = engine.finalize();
  assert.deepEqual(result.calls.map((c) => c.accountId), ['high']);
  assert.equal(result.calls[0].slot, 0);
  assert.deepEqual(result.errors, [{ code: 'NO_CAPACITY', accountId: 'low', deadlineSlot: 2 }]);
});

test('deadline slots are respected', () => {
  const engine = makeEngine(
    [
      { ...baseAccount, id: 'A', positions: { ES: 1 }, initialMarks: { ES: 0 }, deadlineSlot: 0 },
      { ...baseAccount, id: 'B', positions: { ES: 1 }, initialMarks: { ES: 0 }, deadlineSlot: 1 },
    ],
    { slots: 3, slotCapacity: 1 },
  );
  const result = engine.finalize();
  const byId = Object.fromEntries(result.calls.map((c) => [c.accountId, c.slot]));
  assert.equal(byId.A, 0);
  assert.equal(byId.B, 1);
});

test('deterministic: identical inputs produce identical output', () => {
  const build = () => {
    const engine = makeEngine(
      [
        { ...baseAccount, id: 'A', positions: { ES: 1 } },
        { ...baseAccount, id: 'B', positions: { ES: 2 } },
      ],
      { slots: 2, slotCapacity: 1 },
    );
    engine.applyTick({ symbol: 'ES', version: 1, price: 80 });
    engine.applyTick({ symbol: 'ES', version: 2, price: 55 });
    engine.undoTick('ES', 2);
    return engine.finalize();
  };
  assert.deepEqual(build(), build());
});
