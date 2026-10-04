import assert from 'node:assert/strict';
import test from 'node:test';
import { ERR, Ledger } from '../src/ledger.js';

const DAY1 = '2026-10-01';
const DAY2 = '2026-10-02';

function buildHierarchy(ledger) {
  ledger.createBatch({ id: 'G', day: DAY1 });
  ledger.createBatch({ id: 'P', parentId: 'G', day: DAY1 });
  ledger.createBatch({ id: 'C', parentId: 'P', day: DAY1 });
}

test('acceptance 1: grandparent-parent-child rollback clears only unsettled branches', () => {
  const ledger = new Ledger();
  buildHierarchy(ledger);
  ledger.addTx({ id: 'T0', batchId: 'G', account: 'alice', amount: 10, day: DAY1 });
  ledger.settleBatch('G');
  ledger.settleBatch('P');
  ledger.settleBatch('C');
  const sp = ledger.createSavepoint({ id: 'SP', batchId: 'G' });

  ledger.addTx({ id: 'T1', batchId: 'G', account: 'alice', amount: 1, day: DAY1 });
  ledger.addTx({ id: 'T2', batchId: 'P', account: 'bob', amount: 2, day: DAY1 });
  ledger.addTx({ id: 'T3', batchId: 'C', account: 'carol', amount: 3, day: DAY1 });
  ledger.createBatch({ id: 'C2', parentId: 'G', day: DAY1 });
  ledger.addTx({ id: 'T4', batchId: 'C2', account: 'dan', amount: 4, day: DAY1 });

  const plan = ledger.planRollback('SP');
  assert.equal(plan.targetBatch, 'G');
  assert.deepEqual(plan.removals, ['T1', 'T2', 'T3', 'T4']);
  assert.deepEqual(plan.orphans, []);
  assert.deepEqual(plan.removedBatches, ['C2']);
  assert.equal(plan.affectedRange.fromSeq, sp.seq + 1);
  assert.deepEqual(plan.affectedRange.days, [DAY1]);
  assert.equal(plan.affectedRange.txCount, 4);

  const result = ledger.executeRollback(plan);
  assert.notEqual(result.preHash, result.postHash);
  assert.equal(result.removedTxs, 4);

  assert.equal(ledger.txs.get('T0').status, 'settled');
  for (const id of ['T1', 'T2', 'T3', 'T4']) {
    assert.equal(ledger.txs.get(id).status, 'void');
  }
  assert.equal(ledger.batches.get('C2').status, 'rolledback');
  assert.equal(ledger.batches.get('P').status, 'settled');
  assert.deepEqual(ledger.balances(), { alice: 10 });
});

test('acceptance 2: settled child batch requires reversal before rollback', () => {
  const ledger = new Ledger();
  buildHierarchy(ledger);
  ledger.addTx({ id: 'T1', batchId: 'G', account: 'alice', amount: 100, day: DAY1 });
  const sp = ledger.createSavepoint({ id: 'SP', batchId: 'G' });
  ledger.addTx({ id: 'T2', batchId: 'C', account: 'bob', amount: 50, day: DAY1 });
  ledger.settleBatch('G');
  ledger.settleBatch('P');
  ledger.settleBatch('C');

  assert.equal(ledger.txs.get('T2').status, 'settled');
  assert.throws(
    () => ledger.planRollback('SP'),
    (error) => {
      assert.equal(error.code, ERR.ORPHAN);
      assert.deepEqual(error.orphans, ['T2']);
      return true;
    },
  );

  const plan = ledger.planRollback('SP', { reverse: true });
  assert.deepEqual(plan.orphans, ['T2']);
  assert.deepEqual(plan.reversals, [
    { id: 'REV-T2', batchId: 'C', account: 'bob', amount: -50, day: DAY1, reverses: 'T2' },
  ]);
  assert.deepEqual(plan.removals, []);

  const result = ledger.executeRollback(plan);
  assert.equal(result.reversedTxs, 1);
  assert.notEqual(result.preHash, result.postHash);

  const original = ledger.txs.get('T2');
  assert.equal(original.status, 'settled');
  assert.equal(original.reversedBy, 'REV-T2');
  const reversal = ledger.txs.get('REV-T2');
  assert.equal(reversal.amount, -50);
  assert.equal(reversal.reverses, 'T2');
  assert.ok(reversal.seq > sp.seq);
  assert.deepEqual(ledger.balances(), { alice: 100 });
});

test('acceptance 3: cross-day boundary savepoint excludes next day first tx', () => {
  const ledger = new Ledger();
  ledger.createBatch({ id: 'B', day: DAY1 });
  ledger.addTx({ id: 'T1', batchId: 'B', account: 'alice', amount: 11, day: DAY1 });
  const t2 = ledger.addTx({ id: 'T2', batchId: 'B', account: 'alice', amount: 12, day: DAY1 });
  const sp = ledger.createSavepoint({ id: 'SP', batchId: 'B' });
  ledger.closeDay(DAY1);

  const t3 = ledger.addTx({ id: 'T3', batchId: 'B', account: 'alice', amount: 13, day: DAY2 });
  assert.equal(sp.seq, t2.seq);
  assert.ok(sp.seq < t3.seq, 'savepoint must not cover the first tx of the next day');

  const plan = ledger.planRollback('SP');
  assert.deepEqual(plan.removals, ['T3']);
  assert.deepEqual(plan.affectedRange.days, [DAY2]);
  const result = ledger.executeRollback(plan);
  assert.equal(result.removedTxs, 1);
  assert.equal(ledger.txs.get('T3').status, 'void');
  assert.equal(ledger.txs.get('T1').status, 'active');
  assert.equal(ledger.txs.get('T2').status, 'active');
  assert.deepEqual(ledger.balances(), { alice: 23 });
});

test('acceptance 3b: rollback across a closed day fails with E_BOUNDARY', () => {
  const ledger = new Ledger();
  ledger.createBatch({ id: 'B', day: DAY1 });
  ledger.addTx({ id: 'T1', batchId: 'B', account: 'alice', amount: 11, day: DAY1 });
  ledger.createSavepoint({ id: 'SP', batchId: 'B' });
  ledger.addTx({ id: 'T2', batchId: 'B', account: 'alice', amount: 12, day: DAY2 });
  ledger.closeDay(DAY2);
  assert.throws(
    () => ledger.planRollback('SP'),
    (error) => error.code === ERR.BOUNDARY && error.day === DAY2,
  );
});

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function replayBalances(log) {
  const balances = new Map();
  for (const tx of log) {
    if (tx.status === 'void' || tx.status === 'corrected') continue;
    balances.set(tx.account, (balances.get(tx.account) ?? 0) + tx.amount);
  }
  return Object.fromEntries([...balances.entries()].filter(([, v]) => v !== 0));
}

function randomScenario(seed) {
  const rnd = mulberry32(seed);
  const ledger = new Ledger();
  const days = [DAY1, DAY2, '2026-10-03'];
  const accounts = ['alice', 'bob', 'carol'];
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

  ledger.createBatch({ id: 'G', day: days[0] });
  const batches = ['G'];
  if (rnd() < 0.8) {
    ledger.createBatch({ id: 'P', parentId: 'G', day: days[0] });
    batches.push('P');
  }
  if (batches.includes('P') && rnd() < 0.8) {
    ledger.createBatch({ id: 'C', parentId: 'P', day: days[0] });
    batches.push('C');
  }

  let counter = 0;
  const txIds = [];
  const addRandomTx = () => {
    counter += 1;
    const id = `T${counter}`;
    const correctable = txIds.filter((txId) => {
      const tx = ledger.txs.get(txId);
      return tx.status === 'active' || tx.status === 'settled';
    });
    const corrects = correctable.length > 0 && rnd() < 0.25 ? pick(correctable) : null;
    const account = corrects ? ledger.txs.get(corrects).account : pick(accounts);
    ledger.addTx({
      id,
      batchId: pick(batches),
      account,
      amount: 1 + Math.floor(rnd() * 100),
      day: pick(days),
      corrects,
    });
    txIds.push(id);
  };

  const preCount = 2 + Math.floor(rnd() * 5);
  for (let i = 0; i < preCount; i += 1) addRandomTx();

  const settleOrder = ['G', 'P', 'C'].filter((b) => batches.includes(b));
  for (const batchId of settleOrder) {
    if (rnd() < 0.5) {
      try {
        ledger.settleBatch(batchId);
      } catch {
        // parent not settled yet; dependency rule holds
      }
    }
  }

  const spBatch = pick(batches);
  ledger.createSavepoint({ id: 'SP', batchId: spBatch });

  const postCount = 2 + Math.floor(rnd() * 8);
  for (let i = 0; i < postCount; i += 1) addRandomTx();

  for (const batchId of settleOrder) {
    if (ledger.batches.get(batchId).status === 'open' && rnd() < 0.4) {
      try {
        ledger.settleBatch(batchId);
      } catch {
        // parent not settled yet; dependency rule holds
      }
    }
  }

  const plan = ledger.planRollback('SP', { reverse: true });
  ledger.executeRollback(plan);
  return ledger;
}

test('acceptance 4: random small ledgers match per-tx replay reference model', () => {
  for (let seed = 1; seed <= 40; seed += 1) {
    const ledger = randomScenario(seed);
    assert.deepEqual(ledger.balances(), replayBalances(ledger.log), `seed ${seed} balances diverge`);

    const clone = Ledger.fromJSON(JSON.parse(JSON.stringify(ledger.toJSON())));
    assert.equal(clone.hash(), ledger.hash(), `seed ${seed} hash round-trip diverges`);

    for (const tx of ledger.log) {
      if (tx.correctedBy != null && tx.status !== 'void') {
        assert.notEqual(
          ledger.txs.get(tx.correctedBy).status,
          'void',
          `seed ${seed}: correction ${tx.correctedBy} of ${tx.id} must not be voided (no resurrection)`,
        );
      }
    }
  }
});
