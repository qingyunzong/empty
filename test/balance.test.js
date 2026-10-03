'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { mkTmp, writeFile, cli } = require('../testsupport/helpers');

const HEADER = `account 1001 "Cash";
account 2001 "Revenue";
period 2025-01 open;
`;

function runCase(dir, je, events) {
  const jeFile = writeFile(dir, 'batch.je', je);
  const evFile = writeFile(dir, 'events.json', JSON.stringify(events));
  return cli(['run', jeFile, evFile, '--db', path.join(dir, 'db')]);
}

test('E_BALANCE at compile time: unprovable post without balance assertion', () => {
  const dir = mkTmp('je-bal1-');
  const r = runCase(dir, HEADER + `batch B in 2025-01 on sale {
  post dr 1001 event.gross cr 2001 event.net;
}
`, [{ type: 'sale', gross: 10, net: 10 }]);
  assert.equal(r.status, 1);
  assert.equal(r.error.code, 'E_BALANCE');
  assert.match(r.error.message, /cannot statically prove/);
});

test('E_BALANCE at runtime: balance assertion fails on event data', () => {
  const dir = mkTmp('je-bal2-');
  const r = runCase(dir, HEADER + `batch B in 2025-01 on sale {
  post dr 1001 event.gross cr 2001 event.net;
  balance dr == cr;
}
`, [{ type: 'sale', gross: 10, net: 9 }]);
  assert.equal(r.status, 1);
  assert.equal(r.error.code, 'E_BALANCE');
  assert.match(r.error.message, /unbalanced batch B#1/);
});

test('balance assertion passes when event data balances', () => {
  const dir = mkTmp('je-bal3-');
  const r = runCase(dir, HEADER + `batch B in 2025-01 on sale {
  post dr 1001 event.gross cr 2001 event.net;
  balance dr == cr;
}
`, [{ type: 'sale', gross: 10, net: 10 }]);
  assert.equal(r.status, 0, r.error && r.error.message);
});

test('statically provable multi-leg posts need no assertion', () => {
  const dir = mkTmp('je-bal4-');
  const r = runCase(dir, HEADER + `batch B in 2025-01 on sale {
  post dr 1001 event.amount dr 1001 (event.amount * 0.1) cr 2001 (event.amount * 0.1) cr 2001 event.amount;
}
`, [{ type: 'sale', amount: 10 }]);
  assert.equal(r.status, 0, r.error && r.error.message);
});

test('E_SCOPE: template account does not leak outside its batch', () => {
  const dir = mkTmp('je-scope-');
  const r = runCase(dir, HEADER + `template fee(rate) {
  account FEE "Fee Payable";
  post dr 1001 (event.amount * rate) cr FEE (event.amount * rate);
}
batch A in 2025-01 on sale {
  use fee(0.01);
}
batch B in 2025-01 on sale {
  post dr 1001 1 cr FEE 1;
}
`, [{ type: 'sale', amount: 10 }]);
  assert.equal(r.status, 1);
  assert.equal(r.error.code, 'E_SCOPE');
  assert.match(r.error.message, /FEE/);
});

test('E_SCOPE: template-local account invisible before use', () => {
  const dir = mkTmp('je-scope2-');
  const r = runCase(dir, HEADER + `template fee(rate) {
  account FEE "Fee Payable";
  post dr 1001 (event.amount * rate) cr FEE (event.amount * rate);
}
batch A in 2025-01 on sale {
  post dr 1001 1 cr FEE 1;
}
`, [{ type: 'sale', amount: 10 }]);
  assert.equal(r.status, 1);
  assert.equal(r.error.code, 'E_SCOPE');
});
