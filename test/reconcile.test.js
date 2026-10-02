'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCsv, reconcile, ERR_ORPHAN } = require('../src');

const T = '2026-10-03T10:00:00Z';
const T2 = '2026-10-03T10:02:00Z'; // within 300s window
const FAR = '2026-10-03T12:00:00Z'; // outside window

test('csv parser handles quoted fields', () => {
  const rows = parseCsv('id,note\n1,"a,b""c"\n2,plain\n');
  assert.equal(rows[0].note, 'a,b"c');
  assert.equal(rows[1].note, 'plain');
});

test('one-to-one match on amount+currency within time window', () => {
  const r = reconcile({
    channel: [{ recordId: 'CH1', amount: '100.00', currency: 'CNY', timestamp: T }],
    clearing: [{ recordId: 'CL1', amount: '100.00', currency: 'CNY', timestamp: T2 }],
    bank: [{ recordId: 'BK1', amount: '100.00', currency: 'CNY', timestamp: T2 }],
  });
  assert.equal(r.matched.length, 2);
  assert.deepEqual(r.matched[0].chosen, ['CH1']);
  assert.deepEqual(r.matched[1].chosen, ['CL1']);
  assert.equal(r.unmatched.channel.length, 0);
  assert.equal(r.unmatched.orphans.length, 0);
});

test('records outside the time window do not match', () => {
  const r = reconcile({
    channel: [{ recordId: 'CH1', amount: '100.00', currency: 'CNY', timestamp: T }],
    clearing: [{ recordId: 'CL1', amount: '100.00', currency: 'CNY', timestamp: FAR }],
    bank: [],
  });
  assert.equal(r.matched.length, 0);
  assert.equal(r.unmatched.channel.length, 1);
  assert.equal(r.unmatched.clearing.length, 1);
});

test('currency mismatch does not match', () => {
  const r = reconcile({
    channel: [{ recordId: 'CH1', amount: '100.00', currency: 'USD', timestamp: T }],
    clearing: [{ recordId: 'CL1', amount: '100.00', currency: 'CNY', timestamp: T }],
    bank: [],
  });
  assert.equal(r.matched.length, 0);
});

test('one-to-many match: clearing equals sum of channel records', () => {
  const r = reconcile({
    channel: [
      { recordId: 'CH1', amount: '60.00', currency: 'CNY', timestamp: T },
      { recordId: 'CH2', amount: '40.00', currency: 'CNY', timestamp: T2 },
    ],
    clearing: [{ recordId: 'CL1', amount: '100.00', currency: 'CNY', timestamp: T }],
    bank: [],
  });
  assert.equal(r.matched.length, 1);
  assert.deepEqual(r.matched[0].chosen, ['CH1', 'CH2']);
  assert.equal(r.unmatched.channel.length, 0);
});

test('acceptance 4: equal-amount ties are all listed, lexicographic minimum chosen', () => {
  const r = reconcile({
    channel: [
      { recordId: 'CH9', amount: '50.00', currency: 'CNY', timestamp: T },
      { recordId: 'CH3', amount: '50.00', currency: 'CNY', timestamp: T },
      { recordId: 'CH7', amount: '50.00', currency: 'CNY', timestamp: T },
    ],
    clearing: [{ recordId: 'CL1', amount: '50.00', currency: 'CNY', timestamp: T }],
    bank: [],
  });
  assert.equal(r.matched.length, 1);
  const m = r.matched[0];
  assert.deepEqual(m.candidates, [['CH3'], ['CH7'], ['CH9']]); // all ties listed
  assert.deepEqual(m.chosen, ['CH3']); // lexicographic minimum
  assert.deepEqual(m.sources, ['CH3']);
});

test('one-to-many ties: all min-size subsets listed, lexicographic minimum chosen', () => {
  const r = reconcile({
    channel: [
      { recordId: 'CH2', amount: '30.00', currency: 'CNY', timestamp: T },
      { recordId: 'CH1', amount: '70.00', currency: 'CNY', timestamp: T },
      { recordId: 'CH4', amount: '30.00', currency: 'CNY', timestamp: T },
      { recordId: 'CH3', amount: '70.00', currency: 'CNY', timestamp: T },
    ],
    clearing: [{ recordId: 'CL1', amount: '100.00', currency: 'CNY', timestamp: T }],
    bank: [],
  });
  const m = r.matched[0];
  assert.deepEqual(m.candidates, [['CH1', 'CH2'], ['CH1', 'CH4'], ['CH2', 'CH3'], ['CH3', 'CH4']]);
  assert.deepEqual(m.chosen, ['CH1', 'CH2']);
});

test('orphan bank receipt reported with code 21', () => {
  const r = reconcile({
    channel: [],
    clearing: [],
    bank: [{ recordId: 'BK9', amount: '5.00', currency: 'CNY', timestamp: T }],
  });
  assert.equal(r.unmatched.orphans.length, 1);
  assert.equal(r.unmatched.orphans[0].code, ERR_ORPHAN);
});
