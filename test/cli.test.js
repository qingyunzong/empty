'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'cli.js');

function run(args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-cli-io-'));
  const outFile = path.join(dir, 'stdout.txt');
  const errFile = path.join(dir, 'stderr.txt');
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  const res = spawnSync('node', [CLI, ...args], { stdio: ['ignore', outFd, errFd] });
  fs.closeSync(outFd);
  fs.closeSync(errFd);
  return {
    status: res.status,
    stdout: fs.readFileSync(outFile, 'utf8'),
    stderr: fs.readFileSync(errFile, 'utf8'),
  };
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'recon-cli-'));
}

test('cli reconcile writes matched/unmatched csv', () => {
  const dir = tmpDir();
  fs.writeFileSync(
    path.join(dir, 'channels.csv'),
    'txId,batchId,customerId,amount,currency,timestamp\nT1,B1,C1,100,CNY,1000\nT2,B1,C1,60,CNY,1010\nT3,B1,C1,40,CNY,1020\n'
  );
  fs.writeFileSync(
    path.join(dir, 'clearing.csv'),
    'recordId,batchId,amount,currency,timestamp\nCL1,B2,100,CNY,1005\nCL2,B2,60,CNY,1011\nCL3,B2,40,CNY,1021\n'
  );
  fs.writeFileSync(
    path.join(dir, 'bank.csv'),
    'receiptId,batchId,amount,currency,timestamp,confirmed\nR1,B3,100,CNY,1006,false\nR2,B3,100,CNY,1012,false\n'
  );
  const out = path.join(dir, 'out');
  const res = run(['reconcile', '--channels', path.join(dir, 'channels.csv'), '--clearing', path.join(dir, 'clearing.csv'), '--bank', path.join(dir, 'bank.csv'), '--window', '60', '--out', out]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /channel-clearing: matched=3/);
  assert.match(res.stdout, /clearing-bank: matched=2/);
  const matched = fs.readFileSync(path.join(out, 'matched.csv'), 'utf8');
  assert.match(matched, /CL2\+CL3/);
  const unmatched = fs.readFileSync(path.join(out, 'unmatched.csv'), 'utf8');
  assert.equal(unmatched.trim(), 'pair,side,id');
});

test('cli rollback and budget flow', () => {
  const dir = tmpDir();
  fs.writeFileSync(
    path.join(dir, 'batches.csv'),
    'batchId,parentId,layer,customerId,amount,currency,date\nB1,,1,C1,600,CNY,2026-10-01\nB2,B1,2,C1,600,CNY,2026-10-01\n'
  );
  fs.writeFileSync(path.join(dir, 'bank.csv'), 'receiptId,batchId,amount,currency,timestamp,confirmed\n');

  let res = run(['budget', 'set', '--customer', 'C1', '--date', '2026-10-01', '--limit', '1000', '--data', dir]);
  assert.equal(res.status, 0, res.stderr);
  res = run(['budget', 'apply', '--batch', 'B1', '--data', dir]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /applied=true net=600/);
  res = run(['budget', 'check', '--customer', 'C1', '--date', '2026-10-01', '--data', dir]);
  assert.match(res.stdout, /net=600 limit=1000 status=ok/);
  res = run(['rollback', '--batch', 'B1', '--data', dir]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /rolled_back: B1,B2|rolled_back: B2,B1/);
  res = run(['budget', 'check', '--customer', 'C1', '--date', '2026-10-01', '--data', dir]);
  assert.match(res.stdout, /net=0 limit=1000 status=ok/);
});

test('cli orphan receipt exits with code 21', () => {
  const dir = tmpDir();
  fs.writeFileSync(
    path.join(dir, 'batches.csv'),
    'batchId,parentId,layer,customerId,amount,currency,date\nB1,,1,C1,100,CNY,2026-10-01\n'
  );
  fs.writeFileSync(path.join(dir, 'bank.csv'), 'receiptId,batchId,amount,currency,timestamp,confirmed\nR9,GHOST,100,CNY,1000,false\n');
  const res = run(['rollback', '--batch', 'B1', '--data', dir]);
  assert.equal(res.status, 21);
  assert.match(res.stderr, /code=21/);
});

test('cli budget overflow exits with code 22', () => {
  const dir = tmpDir();
  fs.writeFileSync(
    path.join(dir, 'batches.csv'),
    'batchId,parentId,layer,customerId,amount,currency,date\nB1,,1,C1,1500,CNY,2026-10-01\n'
  );
  fs.writeFileSync(path.join(dir, 'bank.csv'), 'receiptId,batchId,amount,currency,timestamp,confirmed\n');
  run(['budget', 'set', '--customer', 'C1', '--date', '2026-10-01', '--limit', '1000', '--data', dir]);
  const res = run(['budget', 'apply', '--batch', 'B1', '--data', dir]);
  assert.equal(res.status, 22);
  assert.match(res.stderr, /code=22/);
});
