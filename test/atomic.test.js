'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { tmpdirPath, writeJson, readJson, runCli } = require('./helpers');
const { buildPatch } = require('../src/diff');
const { join } = require('node:path');

test('over-limit apply fails atomically with first failing opIndex, exit 7', () => {
  const dir = tmpdirPath();
  const base = { accounts: { a1: { limit: 100, used: 0, holds: [] } } };
  const target = { accounts: { a1: { limit: 100, used: 0, holds: [{ hid: 'h1', amount: 60, tag: 'x' }] } } };
  const patch = buildPatch(base, target);
  // Tamper: push a second hold that would overflow the limit, then re-sign
  // via buildPatch on a matching target so the patch itself is well-formed.
  const target2 = {
    accounts: {
      a1: {
        limit: 100, used: 0,
        holds: [{ hid: 'h1', amount: 60, tag: 'x' }, { hid: 'h2', amount: 50, tag: 'y' }],
      },
    },
  };
  // target2 is itself invalid (60+50 > 100), so buildPatch must refuse...
  assert.throws(() => buildPatch(base, target2), /invalid target state/);

  // ...so instead craft the overflowing patch by hand from the valid patch:
  const evil = JSON.parse(JSON.stringify(patch));
  evil.ops.push({ op: 'addHold', account: 'a1', hid: 'h2', amount: 50, tag: 'y' });
  const { canonical, sha256Hex, stateHash } = require('../src/state');
  evil.toHash = stateHash({ accounts: { a1: { limit: 100, used: 0, holds: [
    { hid: 'h1', amount: 60, tag: 'x' }, { hid: 'h2', amount: 50, tag: 'y' }] } } });
  const body = { fromHash: evil.fromHash, toHash: evil.toHash, ops: evil.ops, inverse: evil.inverse };
  evil.sha256 = sha256Hex(canonical(body));

  const statePath = writeJson(dir, 'state.json', base);
  const before = readJson(statePath);
  const patchPath = writeJson(dir, 'evil.json', evil);
  const res = runCli(['apply', statePath, patchPath]);
  assert.equal(res.code, 7);
  assert.equal(res.stderr[0].opIndex, 1); // first failing op
  assert.match(res.stderr[0].error, /limit < used \+ holds/);
  assert.deepEqual(readJson(statePath), before); // atomic: untouched
});

test('unknown op exits 8 with opIndex', () => {
  const dir = tmpdirPath();
  const base = { accounts: { a1: { limit: 100, used: 0, holds: [] } } };
  const { canonical, sha256Hex, stateHash } = require('../src/state');
  const patch = {
    fromHash: stateHash(base),
    toHash: stateHash({ accounts: { a1: { limit: 100, used: 5, holds: [] } } }),
    ops: [{ op: 'setUsed', account: 'a1', used: 5 }],
    inverse: [],
  };
  patch.sha256 = sha256Hex(canonical(patch));
  const statePath = writeJson(dir, 'state.json', base);
  const patchPath = writeJson(dir, 'patch.json', patch);
  const res = runCli(['apply', statePath, patchPath]);
  assert.equal(res.code, 8);
  assert.equal(res.stderr[0].opIndex, 0);
  assert.deepEqual(readJson(statePath), base);
});

test('hash mismatch exits 6', () => {
  const dir = tmpdirPath();
  const base = { accounts: { a1: { limit: 100, used: 0, holds: [] } } };
  const other = { accounts: { a1: { limit: 100, used: 1, holds: [] } } };
  const target = { accounts: { a1: { limit: 100, used: 0, holds: [{ hid: 'h1', amount: 10, tag: 'x' }] } } };
  const patch = buildPatch(base, target);
  const statePath = writeJson(dir, 'state.json', other);
  const patchPath = writeJson(dir, 'patch.json', patch);
  const res = runCli(['apply', statePath, patchPath]);
  assert.equal(res.code, 6);
});
