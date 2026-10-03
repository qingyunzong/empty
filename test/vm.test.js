import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lex } from '../src/lexer.js';
import { parse } from '../src/parser.js';
import { check } from '../src/types.js';
import { compile } from '../src/compiler.js';
import { Ledger } from '../src/ledger.js';
import { Wal } from '../src/wal.js';
import { VM } from '../src/vm.js';

function fixture() {
  return {
    currentDay: 3,
    accounts: {
      'cash.operating': {},
      'revenue.fees': {},
      'vault.frozen': { frozen: true },
    },
    txns: [
      { id: '1001', status: 'SETTLED', day: 3, entries: [
        { account: 'cash.operating', debit: 12500, credit: 0 },
        { account: 'revenue.fees', debit: 0, credit: 12500 } ] },
      { id: '1002', status: 'SETTLED', day: 1, entries: [
        { account: 'cash.operating', debit: 8000, credit: 0 },
        { account: 'revenue.fees', debit: 0, credit: 8000 } ] },
      { id: '1003', status: 'PENDING', day: 3, entries: [] },
      { id: '1004', status: 'FAILED', day: 3, entries: [] },
    ],
  };
}

function runPlan(src, data) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rev-vm-'));
  const wal = new Wal(path.join(dir, 'wal.log'));
  const ledger = new Ledger(data ?? fixture());
  const program = parse(lex(src));
  check(program);
  const vm = new VM({ code: compile(program), ledger, wal });
  vm.run();
  return { ledger, vm, wal };
}

test('scenario 1: same-day SETTLED txn is voided (physical reversal)', () => {
  const { ledger } = runPlan('reverse txn:1001;');
  const txn = ledger.txn('1001');
  assert.equal(txn.status, 'REVERSED');
  assert.equal(txn.entries.length, 0);
  assert.equal(txn.voidedEntries.length, 2);
  assert.deepEqual(ledger.balances()['cash.operating'], 8000); // only 1002 remains
});

test('scenario 2: cross-day LOCKED txn is compensated, never deleted', () => {
  const { ledger } = runPlan('reverse txn:1002;');
  const txn = ledger.txn('1002');
  assert.equal(txn.status, 'REVERSED');
  assert.equal(txn.entries.length, 4); // originals kept + 2 compensating legs
  const comp = txn.entries.filter((e) => e.compensating);
  assert.equal(comp.length, 2);
  assert.ok(comp.every((e) => e.day === 3 && e.reversalId === 'rev:1002'));
  const bal = ledger.balances();
  assert.equal(bal['cash.operating'], 12500); // 1002 nets to zero
  assert.equal(bal['revenue.fees'], -12500);
});

test('scenario 3: PENDING txn is marked CANCEL_REQUESTED, never succeeds', () => {
  const { ledger } = runPlan('cancel txn:1003;');
  const txn = ledger.txn('1003');
  assert.equal(txn.status, 'CANCEL_REQUESTED');
  assert.equal(txn.entries.length, 0); // nothing posted out of thin air
  // reverse on PENDING also degrades to a cancel request
  const again = runPlan('reverse txn:1003;');
  assert.equal(again.ledger.txn('1003').status, 'CANCEL_REQUESTED');
});

test('conditional plan reverses only matching txns', () => {
  const { ledger } = runPlan(`
    for t in [txn:1001, txn:1002, txn:1003, txn:1004] {
      if t.status == SETTLED and t.amount > 0 { reverse t; }
      else if t.status == PENDING { cancel t; }
    }`);
  assert.equal(ledger.txn('1001').status, 'REVERSED');
  assert.equal(ledger.txn('1002').status, 'REVERSED');
  assert.equal(ledger.txn('1003').status, 'CANCEL_REQUESTED');
  assert.equal(ledger.txn('1004').status, 'FAILED');
  const bal = ledger.balances();
  assert.equal(bal['cash.operating'], 0);
  assert.equal(bal['revenue.fees'], 0);
});

test('E_STATE: reversing a non-reversible txn carries txnId and pc', () => {
  let err;
  try { runPlan('reverse txn:1004;'); } catch (e) { err = e; }
  assert.equal(err.code, 'E_STATE');
  assert.equal(err.txnId, '1004');
  assert.equal(typeof err.pc, 'number');
  // unknown txn
  assert.throws(() => runPlan('reverse txn:9999;'),
    (e) => e.code === 'E_STATE' && e.txnId === '9999');
});

test('E_LOCK: moving funds out of a frozen account', () => {
  let err;
  try { runPlan('move 10.00 from acc:vault.frozen to acc:cash.operating;'); } catch (e) { err = e; }
  assert.equal(err.code, 'E_LOCK');
  assert.equal(typeof err.pc, 'number');
});

test('E_DUP: applying the same reversal effect twice', () => {
  const ledger = new Ledger(fixture());
  const effect = { type: 'effect', kind: 'reverse', txnId: '1001', reversalId: 'rev:1001', mode: 'void' };
  ledger.applyEffect(effect, { pc: 0 });
  assert.throws(() => ledger.applyEffect(effect, { pc: 7 }),
    (e) => e.code === 'E_DUP' && e.txnId === '1001' && e.pc === 7);
});

test('move posts a balanced debit/credit pair', () => {
  const { ledger } = runPlan('move 2.50 from acc:revenue.fees to acc:cash.operating;');
  const bal = ledger.balances();
  assert.equal(bal['cash.operating'], 12500 + 8000 + 250);
  assert.equal(bal['revenue.fees'], -12500 - 8000 - 250);
});
