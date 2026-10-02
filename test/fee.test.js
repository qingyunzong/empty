'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  buildRules,
  computeFee,
  FeeError,
  ERR_RULE_CONFLICT,
  ERR_TIME_REVERSED,
} = require('../lib/core');
const { makeTmpDir, writeNdjson, runCli } = require('./helpers');

const TIE_RULES = [
  { op: 'add', ruleId: 'rB', validFrom: 0, validTo: 100, rateBps: 100, priority: 2 },
  { op: 'add', ruleId: 'rA', validFrom: 0, validTo: 100, rateBps: 100, priority: 1 },
  { op: 'add', ruleId: 'rC', validFrom: 0, validTo: 100, rateBps: 150, priority: 3 },
];

test('tied best rules are all reported and selected by fixed priority', () => {
  const rules = buildRules(TIE_RULES);
  const entry = computeFee(rules, { txId: 't1', ts: 50, amount: 10000 });
  assert.deepEqual(entry.tied, ['rA', 'rB']); // all tied best-rate rules reported
  assert.equal(entry.ruleId, 'rA'); // lower priority value wins
  assert.equal(entry.rateBps, 100);
  assert.equal(entry.fee, 100); // 10000 * 100bps / 10000
});

test('tied selection is stable across repeated evaluation', () => {
  const rules = buildRules(TIE_RULES);
  const first = JSON.stringify(computeFee(rules, { txId: 't1', ts: 50, amount: 10000 }));
  for (let i = 0; i < 25; i++) {
    assert.equal(JSON.stringify(computeFee(rules, { txId: 't1', ts: 50, amount: 10000 })), first);
  }
});

test('ruleId breaks the tie when priorities are equal', () => {
  const rules = buildRules([
    { op: 'add', ruleId: 'zeta', validFrom: 0, validTo: 10, rateBps: 50, priority: 1 },
    { op: 'add', ruleId: 'alpha', validFrom: 0, validTo: 10, rateBps: 50, priority: 1 },
  ]);
  const entry = computeFee(rules, { txId: 't', ts: 5, amount: 100 });
  assert.deepEqual(entry.tied, ['alpha', 'zeta']);
  assert.equal(entry.ruleId, 'alpha');
});

test('CLI fee output is stable and explains the final fee', () => {
  const dir = makeTmpDir();
  const rulesPath = path.join(dir, 'rules.ndjson');
  writeNdjson(rulesPath, TIE_RULES);
  const args = ['fee', '--rules', rulesPath, '--amount', '20000', '--at', '50'];
  const run1 = runCli(args);
  const run2 = runCli(args);
  assert.equal(run1.code, 0, run1.stderr);
  assert.equal(run1.stdout, run2.stdout); // stable output
  const out = JSON.parse(run1.stdout);
  assert.deepEqual(out.candidates, [
    { ruleId: 'rA', priority: 1 },
    { ruleId: 'rB', priority: 2 },
  ]);
  assert.deepEqual(out.selected, { ruleId: 'rA', priority: 1 });
  assert.equal(out.fee, 200); // explainable: 20000 * 100bps / 10000
  assert.equal(out.rateBps, 100);
});

test('overlapping rules without declared priority -> code 40', () => {
  assert.throws(
    () =>
      buildRules([
        { op: 'add', ruleId: 'r1', validFrom: 0, validTo: 100, rateBps: 100 },
        { op: 'add', ruleId: 'r2', validFrom: 50, validTo: 150, rateBps: 200 },
      ]),
    (err) => err instanceof FeeError && err.code === ERR_RULE_CONFLICT,
  );
  // one-sided priority is still not enough
  assert.throws(
    () =>
      buildRules([
        { op: 'add', ruleId: 'r1', validFrom: 0, validTo: 100, rateBps: 100, priority: 1 },
        { op: 'add', ruleId: 'r2', validFrom: 50, validTo: 150, rateBps: 200 },
      ]),
    (err) => err.code === ERR_RULE_CONFLICT,
  );
});

test('CLI exits with code 40 on undeclared-priority overlap', () => {
  const dir = makeTmpDir();
  const rulesPath = path.join(dir, 'rules.ndjson');
  writeNdjson(rulesPath, [
    { op: 'add', ruleId: 'r1', validFrom: 0, validTo: 100, rateBps: 100 },
    { op: 'add', ruleId: 'r2', validFrom: 50, validTo: 150, rateBps: 200 },
  ]);
  const run = runCli(['fee', '--rules', rulesPath, '--amount', '1', '--at', '60']);
  assert.equal(run.code, 40);
  assert.equal(JSON.parse(run.stderr).code, 40);
});

test('time going backwards -> code 41', () => {
  // validTo before validFrom
  assert.throws(
    () => buildRules([{ op: 'add', ruleId: 'r1', validFrom: 100, validTo: 50, rateBps: 100 }]),
    (err) => err.code === ERR_TIME_REVERSED,
  );
  // negative tx timestamp
  const rules = buildRules([{ op: 'add', ruleId: 'r1', validFrom: 0, validTo: 100, rateBps: 100 }]);
  assert.throws(() => computeFee(rules, { txId: 't', ts: -1, amount: 10 }), (err) => err.code === 41);
  // non-finite timestamp
  assert.throws(() => computeFee(rules, { txId: 't', ts: NaN, amount: 10 }), (err) => err.code === 41);
});

test('CLI verify rejects reversed interval with code 41', () => {
  const dir = makeTmpDir();
  const rulesPath = path.join(dir, 'rules.ndjson');
  const txPath = path.join(dir, 'tx.ndjson');
  writeNdjson(rulesPath, [{ op: 'add', ruleId: 'r1', validFrom: 0, validTo: 100, rateBps: 100 }]);
  writeNdjson(txPath, []);
  const run = runCli(['verify', '--rules', rulesPath, '--tx', txPath, '--state', path.join(dir, 'st'), '--from', '100', '--to', '50']);
  assert.equal(run.code, 41);
});

test('revoke truncates window but keeps history', () => {
  const rules = buildRules([
    { op: 'add', ruleId: 'r1', validFrom: 0, validTo: 1000, rateBps: 100 },
    { op: 'revoke', ruleId: 'r1', at: 400 },
  ]);
  assert.equal(computeFee(rules, { txId: 'a', ts: 399, amount: 100 }).ruleId, 'r1');
  assert.equal(computeFee(rules, { txId: 'b', ts: 400, amount: 100 }).ruleId, null);
  assert.equal(rules[0].validFrom, 0); // history preserved
  assert.equal(rules[0].validTo, 400);
});
