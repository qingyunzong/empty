'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { mkTmp, writeFile, readJson, readLines, cli } = require('../testsupport/helpers');

const JE = `account 1001 "Cash";
account 2001 "Revenue";
account 6001 "Fee Expense";
period 2025-01 open;

template fee(rate) {
  account FEE "Fee Payable";
  post dr 6001 (event.amount * rate) cr FEE (event.amount * rate);
}

batch SALE in 2025-01 on sale {
  post dr 1001 event.amount cr 2001 event.amount;
  use fee(0.01);
  balance dr == cr;
}

batch REFUND in 2025-01 on refund {
  post dr 2001 event.amount cr 1001 event.amount;
}
`;

// Deterministic PRNG so the test is reproducible.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('acceptance 5: 100 random events match an independent balance table', () => {
  const rand = mulberry32(20251004);
  const events = [];
  for (let i = 0; i < 100; i += 1) {
    const cents = 1 + Math.floor(rand() * 100000); // 0.01 .. 1000.00
    events.push({
      type: rand() < 0.2 ? 'refund' : 'sale',
      amount: cents / 100,
    });
  }

  const dir = mkTmp('je-random-');
  const jeFile = writeFile(dir, 'batch.je', JE);
  const evFile = writeFile(dir, 'events.json', JSON.stringify(events));
  const db = path.join(dir, 'db');
  const r = cli(['run', jeFile, evFile, '--db', db]);
  assert.equal(r.status, 0, r.error && r.error.message);

  // Independent balance table, computed straight from the events with the
  // same rounding the VM specifies (yuan -> micro-units -> cents).
  const expected = {};
  const add = (acct, cents) => { expected[acct] = (expected[acct] || 0) + cents; };
  let saleCount = 0;
  let refundCount = 0;
  for (const e of events) {
    const amount = Math.round(Math.round(e.amount * 1e6) / 1e4);
    const fee = Math.round(Math.round((amount * 1e4 * 0.01 * 1e6) / 1e6) / 1e4);
    if (e.type === 'sale') {
      saleCount += 1;
      add('1001', amount); add('2001', -amount);
      add('6001', fee); add('FEE', -fee);
    } else {
      refundCount += 1;
      add('2001', amount); add('1001', -amount);
    }
  }

  const index = readJson(path.join(db, 'index.json'));
  assert.deepEqual(index.balances, expected);

  // one batch instance per event, all POSTED
  const batchIds = Object.keys(index.batches);
  assert.equal(batchIds.length, 100);
  assert.ok(batchIds.every((id) => index.batches[id] === 'POSTED'));
  assert.equal(batchIds.filter((id) => id.startsWith('SALE#')).length, saleCount);
  assert.equal(batchIds.filter((id) => id.startsWith('REFUND#')).length, refundCount);

  // every posting is individually balanced (dr == cr)
  const postings = readLines(path.join(db, 'postings.jsonl')).map((l) => JSON.parse(l));
  assert.equal(postings.length, saleCount * 2 + refundCount);
  for (const p of postings) {
    const dr = p.legs.filter((l) => l.side === 'dr').reduce((s, l) => s + l.amount, 0);
    const cr = p.legs.filter((l) => l.side === 'cr').reduce((s, l) => s + l.amount, 0);
    assert.equal(dr, cr, `posting seq=${p.seq} unbalanced`);
  }

  // index equals the sum of the durable postings (no double, no missing)
  const fromPostings = {};
  for (const p of postings) {
    for (const leg of p.legs) {
      const signed = leg.side === 'dr' ? leg.amount : -leg.amount;
      fromPostings[leg.account] = (fromPostings[leg.account] || 0) + signed;
    }
  }
  assert.deepEqual(index.balances, fromPostings);
});
