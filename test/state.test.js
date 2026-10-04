'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { applyRules, snapshot, undo, loadState } = require('../src/state');

const rulesA = [{ id: 'r1', pattern: 'a*', decision: 'flag' }];
const rulesB = [{ id: 'r2', pattern: 'b*', decision: 'flag' }];
const rulesC = [{ id: 'r3', pattern: 'c*', decision: 'pass' }];

function tmpState() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-state-'));
  return path.join(dir, 'state.json');
}

test('acceptance D: consecutive applies then undo restores the previous hash', () => {
  const statePath = tmpState();
  applyRules(statePath, rulesA);
  const hashA = loadState(statePath).hash;
  snapshot(statePath);
  applyRules(statePath, rulesB);
  const hashB = loadState(statePath).hash;
  applyRules(statePath, rulesC);
  const hashC = loadState(statePath).hash;
  assert.notStrictEqual(hashA, hashB);
  assert.notStrictEqual(hashB, hashC);

  undo(statePath);
  const restored = loadState(statePath);
  assert.strictEqual(restored.hash, hashA);
  assert.deepStrictEqual(restored.rules, rulesA);
});

test('undo without an explicit snapshot reports NO_SNAPSHOT and writes nothing', () => {
  const statePath = tmpState();
  assert.throws(() => undo(statePath), (err) => err.code === 'NO_SNAPSHOT');
  assert.ok(!fs.existsSync(statePath), 'state file must not be created');

  applyRules(statePath, rulesA); // apply does not create an implicit snapshot
  const before = fs.readFileSync(statePath, 'utf8');
  assert.throws(() => undo(statePath), (err) => err.code === 'NO_SNAPSHOT');
  assert.strictEqual(fs.readFileSync(statePath, 'utf8'), before, 'state file must be unchanged');
});

test('each undo consumes exactly one explicit snapshot', () => {
  const statePath = tmpState();
  applyRules(statePath, rulesA);
  snapshot(statePath);
  applyRules(statePath, rulesB);
  snapshot(statePath);
  applyRules(statePath, rulesC);
  undo(statePath);
  assert.deepStrictEqual(loadState(statePath).rules, rulesB);
  undo(statePath);
  assert.deepStrictEqual(loadState(statePath).rules, rulesA);
  assert.throws(() => undo(statePath), (err) => err.code === 'NO_SNAPSHOT');
});

test('acceptance B: apply with an invalid rule reports BAD_REGEX and writes no state', () => {
  const statePath = tmpState();
  const bad = [{ id: 'bad', pattern: '(a\\1)', decision: 'flag' }];
  assert.throws(() => applyRules(statePath, bad), (err) => err.code === 'BAD_REGEX');
  assert.ok(!fs.existsSync(statePath), 'state file must not be created');

  applyRules(statePath, rulesA);
  const before = fs.readFileSync(statePath, 'utf8');
  assert.throws(() => applyRules(statePath, bad), (err) => err.code === 'BAD_REGEX');
  assert.strictEqual(fs.readFileSync(statePath, 'utf8'), before, 'state file must be unchanged');
});
