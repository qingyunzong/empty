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

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ACCOUNTS = ['cash.operating', 'revenue.fees', 'liab.hold', 'equity.main', 'clearing'];

function randomLedger(rand, n) {
  const txns = [];
  for (let i = 0; i < n; i++) {
    const r = rand();
    const status = r < 0.5 ? 'SETTLED' : r < 0.7 ? 'PENDING'
      : r < 0.8 ? 'FAILED' : r < 0.9 ? 'REVERSED' : 'CANCEL_REQUESTED';
    const txn = { id: `t${i}`, status, day: 1 + Math.floor(rand() * 3) };
    if (rand() < 0.1) txn.locked = true;
    if (status === 'SETTLED' || status === 'REVERSED') {
      const amount = 1 + Math.floor(rand() * 50000);
      const a = ACCOUNTS[Math.floor(rand() * ACCOUNTS.length)];
      let b = ACCOUNTS[Math.floor(rand() * ACCOUNTS.length)];
      if (b === a) b = ACCOUNTS[(ACCOUNTS.indexOf(a) + 1) % ACCOUNTS.length];
      txn.entries = [
        { account: a, debit: amount, credit: 0 },
        { account: b, debit: 0, credit: amount },
      ];
    } else {
      txn.entries = [];
    }
    txns.push(txn);
  }
  return { currentDay: 3, accounts: {}, txns };
}

// Brute-force reference: an independent, naive fold over the same state
// machine (SETTLED -> REVERSED, PENDING -> CANCEL_REQUESTED, locked ->
// compensate instead of void).
function referenceRun(ledgerData, ids) {
  const data = structuredClone(ledgerData);
  for (const id of ids) {
    const txn = data.txns.find((t) => String(t.id) === String(id));
    if (txn.status === 'SETTLED') {
      const locked = txn.locked === true
        || (txn.day != null && data.currentDay != null && txn.day < data.currentDay);
      if (locked) {
        for (const e of [...txn.entries]) {
          txn.entries.push({ account: e.account, debit: e.credit || 0, credit: e.debit || 0 });
        }
      } else {
        txn.entries = [];
      }
      txn.status = 'REVERSED';
    } else if (txn.status === 'PENDING') {
      txn.status = 'CANCEL_REQUESTED';
    }
  }
  const balances = {};
  for (const txn of data.txns) {
    for (const e of txn.entries || []) {
      balances[e.account] = (balances[e.account] || 0) + (e.debit || 0) - (e.credit || 0);
    }
  }
  const statuses = {};
  for (const txn of data.txns) statuses[txn.status] = (statuses[txn.status] || 0) + 1;
  return { balances, statuses };
}

function vmRun(ledgerData, ids) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rev-fuzz-'));
  const plan = `
    for t in [${ids.map((id) => `txn:${id}`).join(', ')}] {
      if t.status == SETTLED { reverse t; }
      else if t.status == PENDING { cancel t; }
    }`;
  const program = parse(lex(plan));
  check(program);
  const ledger = new Ledger(structuredClone(ledgerData));
  const vm = new VM({
    code: compile(program),
    ledger,
    wal: new Wal(path.join(dir, 'wal.log')),
  });
  vm.run();
  const statuses = {};
  for (const txn of ledger.data.txns) statuses[txn.status] = (statuses[txn.status] || 0) + 1;
  return { balances: ledger.balances(), statuses, ledger };
}

for (const seed of [11, 222, 3333, 44444, 555555]) {
  test(`fuzz seed=${seed}: 50-txn ledger matches brute-force state machine`, () => {
    const rand = mulberry32(seed);
    const data = randomLedger(rand, 50);
    const ids = data.txns.map((t) => t.id);

    const expected = referenceRun(data, ids);
    const actual = vmRun(data, ids);

    assert.deepEqual(actual.balances, expected.balances);
    assert.deepEqual(actual.statuses, expected.statuses);

    // Double-entry invariant: every posting is balanced, so balances sum to 0.
    const total = Object.values(actual.balances).reduce((a, b) => a + b, 0);
    assert.equal(total, 0);
  });
}
