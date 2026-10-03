'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { mkTmp, writeFile, cli } = require('../testsupport/helpers');

const EVENTS = JSON.stringify([{ type: 'sale', amount: 10.00 }]);

test('acceptance 4: posting into a closed period fails with E_PERIOD', () => {
  const dir = mkTmp('je-period-');
  const jeFile = writeFile(dir, 'batch.je', `account 1001 "Cash";
account 2001 "Revenue";
period 2024-12 closed;
batch SALE in 2024-12 on sale {
  post dr 1001 event.amount cr 2001 event.amount;
}
`);
  const evFile = writeFile(dir, 'events.json', EVENTS);
  const r = cli(['run', jeFile, evFile, '--db', path.join(dir, 'db')]);
  assert.equal(r.status, 1);
  assert.equal(r.error.code, 'E_PERIOD');
  assert.match(r.error.message, /2024-12.*closed/);
});

test('posting into an undeclared period fails with E_PERIOD', () => {
  const dir = mkTmp('je-period2-');
  const jeFile = writeFile(dir, 'batch.je', `account 1001 "Cash";
account 2001 "Revenue";
period 2025-01 open;
batch SALE in 2025-02 on sale {
  post dr 1001 event.amount cr 2001 event.amount;
}
`);
  const evFile = writeFile(dir, 'events.json', EVENTS);
  const r = cli(['run', jeFile, evFile, '--db', path.join(dir, 'db')]);
  assert.equal(r.status, 1);
  assert.equal(r.error.code, 'E_PERIOD');
  assert.match(r.error.message, /unknown period/);
});
