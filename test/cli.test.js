import test from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from '../src/cli.js';
import { tmpDir, sampleLabels, sampleDictValues, expectedNormalized, corruptBlockPayload } from '../testutil/helpers.js';
import { readIndex } from '../src/reader.js';
import { BLOCK_TYPE } from '../src/format.js';

function run(...args) {
  return runCli(args);
}

function runOk(...args) {
  const res = run(...args);
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

test('CLI end-to-end: init, dict, append, dump, verify, blocks', () => {
  const dir = tmpDir();
  assert.deepStrictEqual(runOk('init', dir).ok, true);
  const dict = runOk('dict', dir, '--set', JSON.stringify(sampleDictValues()));
  assert.equal(dict.dictVersion, 1);
  const appended = runOk('append', dir, '--labels', JSON.stringify(sampleLabels()));
  assert.equal(appended.count, 3);

  const dump = runOk('dump', dir);
  assert.deepStrictEqual(dump.labels, expectedNormalized());
  assert.deepStrictEqual(dump.errors, []);

  const verify = runOk('verify', dir);
  assert.equal(verify.ok, true);
  assert.equal(verify.labels, 3);

  const blocks = runOk('blocks', dir);
  assert.deepStrictEqual(blocks.map((b) => b.type), [BLOCK_TYPE.DICT, BLOCK_TYPE.RECORDS]);
});

test('CLI append --auto-dict bootstraps the first dictionary', () => {
  const dir = tmpDir();
  runOk('init', dir);
  const res = runOk('append', dir, '--labels', JSON.stringify(sampleLabels().slice(0, 1)), '--auto-dict');
  assert.equal(res.dictVersion, 1);
  const dump = runOk('dump', dir);
  assert.deepStrictEqual(dump.labels, expectedNormalized().slice(0, 1));
});

test('CLI verify exits non-zero on corruption and reports the error code', () => {
  const dir = tmpDir();
  runOk('init', dir);
  runOk('dict', dir, '--set', JSON.stringify(sampleDictValues()));
  runOk('append', dir, '--labels', JSON.stringify(sampleLabels()));

  const entry = readIndex(dir).find((e) => e.type === BLOCK_TYPE.RECORDS);
  corruptBlockPayload(dir, entry, 0);

  const res = run('verify', dir);
  assert.equal(res.code, 1);
  const out = JSON.parse(res.stdout);
  assert.equal(out.ok, false);
  assert.ok(out.errors.some((e) => e.code === 'E_CRC'));
});

test('CLI reports unknown command and bad arguments with exit code 2', () => {
  const res = run('frobnicate', '/tmp/nowhere');
  assert.equal(res.code, 2);
  const err = JSON.parse(res.stderr);
  assert.equal(err.ok, false);
  assert.equal(err.error.code, 'E_ARG');
});
