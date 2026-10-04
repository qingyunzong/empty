'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { applyRules, snapshot, undo, status, hashRules } = require('../lib/state');
const { AuditError } = require('../lib/errors');

function tmpState() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-state-'));
  return path.join(dir, 'state.json');
}

const V1 = { rules: [{ id: 'usd', pattern: '[^]*\\|USD\\|[^]*', action: 'flag' }] };
const V2 = { rules: [{ id: 'eur', pattern: '[^]*\\|EUR\\|[^]*', action: 'flag' }] };
const V3 = { rules: [{ id: 'jpy', pattern: '[^]*\\|JPY\\|[^]*', action: 'flag' }] };

test('acceptance D: consecutive applies then undo restores the previous hash', () => {
  const state = tmpState();
  const r1 = applyRules(state, V1);
  const r2 = applyRules(state, V2);
  const r3 = applyRules(state, V3);
  assert.notEqual(r1.hash, r2.hash);
  assert.notEqual(r2.hash, r3.hash);

  const u1 = undo(state);
  assert.equal(u1.hash, r2.hash, 'first undo restores the previous version hash');
  const u2 = undo(state);
  assert.equal(u2.hash, r1.hash);
  assert.throws(() => undo(state), (e) => e instanceof AuditError && e.code === 'NO_SNAPSHOT');
});

test('hash is a sha256 of the canonical rules and matches status', () => {
  const state = tmpState();
  const r = applyRules(state, V1);
  assert.match(r.hash, /^[0-9a-f]{64}$/);
  assert.equal(status(state).current, r.hash);
  assert.equal(r.hash, hashRules(JSON.parse(fs.readFileSync(state, 'utf8')).current.rules));
});

test('undo only reverts to explicit snapshots', () => {
  const state = tmpState();
  const r1 = applyRules(state, V1);
  // No snapshot yet: undo is impossible.
  assert.throws(() => undo(state), (e) => e.code === 'NO_SNAPSHOT');
  // An explicit snapshot makes undo possible and restores that exact version.
  snapshot(state);
  const u = undo(state);
  assert.equal(u.hash, r1.hash);
  assert.throws(() => undo(state), (e) => e.code === 'NO_SNAPSHOT');
});

test('apply with invalid rules fails with BAD_REGEX and does not touch state', () => {
  const state = tmpState();
  const before = applyRules(state, V1);
  const contentsBefore = fs.readFileSync(state, 'utf8');
  assert.throws(
    () => applyRules(state, { rules: ['a(b'] }),
    (e) => e.code === 'BAD_REGEX'
  );
  assert.equal(fs.readFileSync(state, 'utf8'), contentsBefore);
  assert.equal(status(state).current, before.hash);
});
