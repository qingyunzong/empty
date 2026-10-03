'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { dependencyClosure, bruteForceClosure, rollbackBatch } = require('../lib/rollback');
const { Store } = require('../lib/store');
const { ERR } = require('../lib/errors');

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function genBatches(n, seed) {
  const rnd = mulberry32(seed);
  const batches = [];
  for (let i = 0; i < n; i++) {
    const id = `B${String(i).padStart(3, '0')}`;
    const parentId = i === 0 || rnd() >= 0.7 ? null : `B${String(Math.floor(rnd() * i)).padStart(3, '0')}`;
    batches.push({
      batchId: id,
      parentId,
      layer: (i % 3) + 1,
      customerId: `C${i % 5}`,
      amount: 100 * (i + 1),
      currency: 'CNY',
      date: '2026-10-01',
      status: 'active',
      budgetApplied: false,
    });
  }
  return batches;
}

test('dependency closure matches brute-force enumeration for n<=9 (all nodes, 20 seeds)', () => {
  for (let n = 1; n <= 9; n++) {
    for (let seed = 0; seed < 20; seed++) {
      const batches = genBatches(n, seed * 100 + n);
      for (const b of batches) {
        assert.deepEqual(
          dependencyClosure(batches, b.batchId),
          bruteForceClosure(batches, b.batchId),
          `n=${n} seed=${seed} root=${b.batchId}`
        );
      }
    }
  }
});

test('100 batches with nested dependencies: closure matches brute-force for every node', () => {
  const batches = genBatches(100, 42);
  for (const b of batches) {
    assert.deepEqual(dependencyClosure(batches, b.batchId), bruteForceClosure(batches, b.batchId));
  }
});

function makeStore(batchesCsv, bankCsv) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-'));
  fs.writeFileSync(path.join(dir, 'batches.csv'), batchesCsv);
  fs.writeFileSync(path.join(dir, 'bank.csv'), bankCsv);
  return new Store(dir).load();
}

const BANK_HEADER = 'receiptId,batchId,amount,currency,timestamp,confirmed\n';

test('rollback rolls back the batch and its dependent child batches only', () => {
  const csv = [
    'batchId,parentId,layer,customerId,amount,currency,date',
    'B1,,1,C1,100,CNY,2026-10-01',
    'B2,B1,2,C1,100,CNY,2026-10-01',
    'B3,B2,3,C1,100,CNY,2026-10-01',
    'B9,,1,C2,50,CNY,2026-10-01',
    '',
  ].join('\n');
  const store = makeStore(csv, BANK_HEADER);
  const res = rollbackBatch(store, 'B1');
  assert.deepEqual(res.rolledBack.sort(), ['B1', 'B2', 'B3']);
  const byId = new Map(store.batches.map((b) => [b.batchId, b]));
  assert.equal(byId.get('B1').status, 'rolled_back');
  assert.equal(byId.get('B2').status, 'rolled_back');
  assert.equal(byId.get('B3').status, 'rolled_back');
  assert.equal(byId.get('B9').status, 'active');
});

test('confirmed bank batch triggers reversal adjustment, original status unchanged', () => {
  const csv = [
    'batchId,parentId,layer,customerId,amount,currency,date',
    'B1,,1,C1,100,CNY,2026-10-01',
    'B2,B1,2,C1,100,CNY,2026-10-01',
    'B3,B2,3,C1,100,CNY,2026-10-01',
    '',
  ].join('\n');
  const bankCsv = BANK_HEADER + 'R1,B3,100,CNY,1000,true\n';
  const store = makeStore(csv, bankCsv);
  const res = rollbackBatch(store, 'B1');
  assert.deepEqual(res.rolledBack.sort(), ['B1', 'B2']);
  assert.equal(res.adjustments.length, 1);
  const adj = res.adjustments[0];
  assert.equal(adj.batchId, 'ADJ-B3');
  assert.equal(adj.amount, -100);
  assert.equal(adj.kind, 'reversal');
  const byId = new Map(store.batches.map((b) => [b.batchId, b]));
  assert.equal(byId.get('B3').status, 'active');
  assert.equal(byId.get('ADJ-B3').status, 'active');
  assert.equal(byId.get('ADJ-B3').parentId, 'B3');
});

test('cyclic dependency yields code=20', () => {
  const csv = [
    'batchId,parentId,layer,customerId,amount,currency,date',
    'B1,B2,1,C1,100,CNY,2026-10-01',
    'B2,B1,2,C1,100,CNY,2026-10-01',
    '',
  ].join('\n');
  const store = makeStore(csv, BANK_HEADER);
  assert.throws(() => rollbackBatch(store, 'B1'), (err) => err.code === ERR.CYCLE);
});

test('orphan receipt yields code=21', () => {
  const csv = [
    'batchId,parentId,layer,customerId,amount,currency,date',
    'B1,,1,C1,100,CNY,2026-10-01',
    '',
  ].join('\n');
  const bankCsv = BANK_HEADER + 'R9,GHOST,100,CNY,1000,false\n';
  const store = makeStore(csv, bankCsv);
  assert.throws(() => rollbackBatch(store, 'B1'), (err) => err.code === ERR.ORPHAN_RECEIPT);
});
