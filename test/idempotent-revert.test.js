'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { tmpdirPath, writeJson, readJson, runCli } = require('./helpers');
const { join } = require('node:path');

const base = {
  accounts: {
    a1: { limit: 150, used: 20, holds: [{ hid: 'h1', amount: 10, tag: 'fraud' }] },
  },
};
const target = {
  accounts: {
    a1: { limit: 200, used: 20, holds: [{ hid: 'h1', amount: 10, tag: 'review' }, { hid: 'h2', amount: 30, tag: 'legal' }] },
  },
};

function setup() {
  const dir = tmpdirPath();
  const statePath = writeJson(dir, 'state.json', base);
  const targetPath = writeJson(dir, 'target.json', target);
  const patchPath = join(dir, 'patch.json');
  assert.equal(runCli(['diff', statePath, targetPath, '--out', patchPath]).code, 0);
  return { statePath, patchPath };
}

test('repeated apply is idempotent', () => {
  const { statePath, patchPath } = setup();
  assert.equal(runCli(['apply', statePath, patchPath]).code, 0);
  const once = readJson(statePath);
  const res = runCli(['apply', statePath, patchPath]);
  assert.equal(res.code, 0);
  assert.equal(res.stdout[0].status, 'already-applied');
  assert.deepEqual(readJson(statePath), once);
});

test('revert only when current hash equals toHash', () => {
  const { statePath, patchPath } = setup();
  // revert before apply: current hash == fromHash != toHash -> refuse
  const early = runCli(['revert', statePath, patchPath]);
  assert.equal(early.code, 6);
  assert.match(early.stderr[0].error, /revert refused/);
  assert.deepEqual(readJson(statePath), base);

  // apply then revert: accepted
  assert.equal(runCli(['apply', statePath, patchPath]).code, 0);
  const ok = runCli(['revert', statePath, patchPath]);
  assert.equal(ok.code, 0);
  assert.deepEqual(readJson(statePath), base);

  // revert again: refused (hash now equals fromHash)
  const again = runCli(['revert', statePath, patchPath]);
  assert.equal(again.code, 6);
});

test('tampered patch is rejected with exit 6', () => {
  const { statePath, patchPath } = setup();
  const patch = readJson(patchPath);
  patch.ops[0].limit = 999;
  writeJson(require('node:path').dirname(patchPath), 'tampered.json', patch);
  const res = runCli(['apply', statePath, join(require('node:path').dirname(patchPath), 'tampered.json')]);
  assert.equal(res.code, 6);
  assert.match(res.stderr[0].error, /sha256/);
});
