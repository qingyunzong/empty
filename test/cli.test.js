import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../src/cli.js';
import { createBlock } from '../src/block.js';

function makeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'settle-cli-'));
}

function run(dir, ...args) {
  return runCli(['--dir', dir, ...args]);
}

test('happy path: budget, propose, finalize, state, verify all exit 0', () => {
  const dir = makeDir();
  assert.equal(run(dir, 'budget', 'alice', '100').code, 0);
  assert.equal(run(dir, 'propose', 't1', 'alice', 'bob', '10').code, 0);
  assert.equal(run(dir, 'propose', 't2', 'alice', 'carol', '20').code, 0);
  const fin = run(dir, 'finalize');
  assert.equal(fin.code, 0, fin.stderr);
  const block = JSON.parse(fin.stdout);
  assert.equal(block.level, 1);
  assert.deepEqual(block.transfers, ['t1', 't2']);
  const state = JSON.parse(run(dir, 'state').stdout);
  assert.equal(state.balances.alice, 30);
  assert.equal(state.remaining.alice, 70);
  const ver = run(dir, 'verify');
  assert.equal(ver.code, 0);
  assert.match(ver.stdout, /OK/);
});

test('business conflicts exit 1', () => {
  const dir = makeDir();
  assert.equal(run(dir, 'finalize').code, 1, 'no pending transfers');
  run(dir, 'propose', 't1', 'alice', 'bob', '10');
  assert.equal(run(dir, 'propose', 't1', 'alice', 'bob', '10').code, 1, 'duplicate');
  assert.equal(run(dir, 'correct', '5').code, 1, 'unknown level');
  assert.equal(run(dir, 'rollback', '1').code, 1, 'unknown level');
  assert.equal(run(dir, 'propose', 't2', 'alice', 'bob', '-3').code, 1, 'bad amount');
});

test('corrupt block makes verify exit 2 with CORRUPT', () => {
  const dir = makeDir();
  run(dir, 'propose', 't1', 'alice', 'bob', '10');
  const block = JSON.parse(run(dir, 'finalize').stdout);
  const file = path.join(dir, 'blocks', `${block.hash}.json`);
  const tampered = JSON.parse(fs.readFileSync(file, 'utf8'));
  tampered.transfers.push('tX');
  fs.writeFileSync(file, JSON.stringify(tampered, null, 2));
  const ver = run(dir, 'verify');
  assert.equal(ver.code, 2);
  assert.match(ver.stdout, /CORRUPT/);
});

test('missing parent makes verify exit 2 with MISSING', () => {
  const dir = makeDir();
  run(dir, 'propose', 't1', 'alice', 'bob', '10');
  run(dir, 'finalize');
  const orphan = createBlock({ level: 2, parent: 'e'.repeat(64), transfers: [], deltas: {}, index: [] });
  fs.writeFileSync(path.join(dir, 'blocks', `${orphan.hash}.json`), JSON.stringify(orphan, null, 2));
  const ver = run(dir, 'verify');
  assert.equal(ver.code, 2);
  assert.match(ver.stdout, /MISSING/);
});

test('correct via CLI cascades and re-settles', () => {
  const dir = makeDir();
  run(dir, 'budget', 'alice', '100');
  run(dir, 'budget', 'bob', '100');
  run(dir, 'budget', 'carol', '100');
  run(dir, 'propose', 't1', 'alice', 'bob', '10');
  run(dir, 'finalize');
  run(dir, 'propose', 't2', 'alice', 'carol', '20');
  run(dir, 'finalize');
  run(dir, 'propose', 't3', 'carol', 'alice', '5');
  run(dir, 'finalize');
  const before = JSON.parse(run(dir, 'state').stdout);
  assert.equal(before.tipLevel, 3);
  const level1Hash = before.levels[0].hash;
  const cor = run(dir, 'correct', '2');
  assert.equal(cor.code, 0, cor.stderr);
  const after = JSON.parse(run(dir, 'state').stdout);
  assert.equal(after.tipLevel, 2);
  assert.equal(after.levels[0].hash, level1Hash, 'unrelated batch kept');
  assert.equal(after.rolledBack.length, 2);
  assert.deepEqual(after.settled, ['t1', 't2', 't3']);
  assert.equal(run(dir, 'verify').code, 0);
});
