'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { tmpDir, cli, writeConfig, readFile } = require('./helpers');
const { quotaProof } = require('../src/core');

const QUOTA = 100;

function setup() {
  const dir = tmpDir();
  const cfgPath = writeConfig(dir, {
    workers: [{ id: 'w1', throughput: 1, maxLevel: 3 }],
    quotas: { T: QUOTA },
    periodLength: 10,
    boostThreshold: 3,
  });
  assert.equal(cli(['init', '--dir', dir, '--config', cfgPath]).status, 0);
  return dir;
}

function submitArgs(id, prevHash, proof) {
  return [
    'submit', '--id', id, '--tenant', 'T', '--submitter', 's1',
    '--size', '5', '--level', '1', '--deadline', '9',
    '--prev-hash', prevHash, '--evidence-hash', `ev-${id}`,
    '--client', 'c1', '--lamport', '1', '--quota-proof', proof,
  ];
}

function stateBytes(dir) {
  return {
    journal: readFile(path.join(dir, 'journal.jsonl')),
    snap: readFile(path.join(dir, 'state.json')),
  };
}

test('broken hash chain exits 4 and leaves state unchanged', () => {
  const dir = setup();
  const good = cli([...submitArgs('p1', 'GENESIS', quotaProof('T', QUOTA)), '--dir', dir]);
  assert.equal(good.status, 0, good.stderr);
  const before = stateBytes(dir);
  const bad = cli([...submitArgs('p2', 'deadbeef', quotaProof('T', QUOTA)), '--dir', dir]);
  assert.equal(bad.status, 4);
  assert.match(bad.stderr, /hash-chain-broken/);
  assert.deepEqual(stateBytes(dir), before, 'state unchanged after rejected submit');
});

test('forged quota proof exits 4 and leaves state unchanged', () => {
  const dir = setup();
  const before = stateBytes(dir);
  const forged = quotaProof('T', QUOTA * 2); // proof computed with inflated quota
  const bad = cli([...submitArgs('p1', 'GENESIS', forged), '--dir', dir]);
  assert.equal(bad.status, 4);
  assert.match(bad.stderr, /quota-forgery/);
  assert.deepEqual(stateBytes(dir), before, 'state unchanged after forged quota');
});

test('duplicate package exits 4 and leaves state unchanged', () => {
  const dir = setup();
  const args = [...submitArgs('p1', 'GENESIS', quotaProof('T', QUOTA)), '--dir', dir];
  assert.equal(cli(args).status, 0);
  const before = stateBytes(dir);
  const dup = cli(args);
  assert.equal(dup.status, 4);
  assert.match(dup.stderr, /duplicate-package/);
  assert.deepEqual(stateBytes(dir), before, 'state unchanged after duplicate submit');
});
