'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'cli.js');

let counter = 0;
// The sandbox swallows grandchild stdout over pipes, so redirect to files.
function run(args) {
  const outF = path.join(os.tmpdir(), `cli-out-${process.pid}-${counter}.txt`);
  const errF = path.join(os.tmpdir(), `cli-err-${process.pid}-${counter}.txt`);
  counter += 1;
  const outFd = fs.openSync(outF, 'w');
  const errFd = fs.openSync(errF, 'w');
  const r = spawnSync(process.execPath, [CLI, ...args], { stdio: ['ignore', outFd, errFd] });
  fs.closeSync(outFd);
  fs.closeSync(errFd);
  return {
    status: r.status,
    stdout: fs.readFileSync(outF, 'utf8'),
    stderr: fs.readFileSync(errF, 'utf8'),
  };
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cli-test-'));
}

test('cli append/judge/repair end-to-end', () => {
  const dir = tmpdir();
  const h = path.join(dir, 'history.ndjson');
  const cfg = path.join(dir, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({ default: { limit: 100, dailyFreezeCap: 100 } }));

  // append a freeze and an over-release
  let r = run(['append', '--history', h, '--account', 'A', '--type', 'freeze', '--amount', '80', '--opId', 'f1', '--ts', '1', '--day', '2026-10-02']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).appended.opId, 'f1');

  r = run(['append', '--history', h, '--account', 'A', '--type', 'release', '--amount', '90', '--ref', 'f1', '--opId', 'r1', '--ts', '2']);
  assert.equal(r.status, 0, r.stderr);

  // duplicate opId is rejected with code 12
  r = run(['append', '--history', h, '--account', 'A', '--type', 'freeze', '--amount', '5', '--opId', 'f1']);
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout).code, 12);

  // judge computes available quota
  r = run(['judge', '--history', h, '--config', cfg]);
  assert.equal(r.status, 0, r.stderr);
  const judged = JSON.parse(r.stdout);
  assert.equal(judged.accounts.A.available, 20); // 100 - 80
  const r1 = judged.accounts.A.verdicts.find((v) => v.opId === 'r1');
  assert.equal(r1.code, 10);

  // repair appends exactly one compensation for r1
  r = run(['repair', '--history', h, '--config', cfg]);
  assert.equal(r.status, 0, r.stderr);
  const summary = JSON.parse(r.stdout);
  assert.deepEqual(summary.added.map((c) => c.opId), ['cmp:r1']);

  // repair again: no-op (exactly once)
  r = run(['repair', '--history', h, '--config', cfg]);
  assert.equal(JSON.parse(r.stdout).added.length, 0);

  // crash injection: exit code 2, partial write, recovery completes
  const h2 = path.join(dir, 'h2.ndjson');
  fs.copyFileSync(path.join(dir, 'history.ndjson'), h2);
  // remove the compensation lines to have 1 erroneous op again
  const lines = fs.readFileSync(h2, 'utf8').split('\n').filter((l) => l && !l.includes('"compensate"'));
  fs.writeFileSync(h2, lines.join('\n') + '\n');
  r = run(['repair', '--history', h2, '--config', cfg, '--crash-after', '1']);
  assert.equal(r.status, 2);
  assert.equal(JSON.parse(r.stdout).crashed, true);
  r = run(['repair', '--history', h2, '--config', cfg]);
  assert.equal(r.status, 0);
  const comps = fs.readFileSync(h2, 'utf8').split('\n').filter((l) => l.includes('"compensate"'));
  assert.equal(comps.length, 1, 'compensation written exactly once after crash+recovery');
});

test('cli judge prints tied-optimal sequences with stable order', () => {
  const dir = tmpdir();
  const h = path.join(dir, 'history.ndjson');
  const ops = [
    { opId: 'f1', account: 'A', type: 'freeze', amount: 100, day: 'd', ts: 1, causes: [] },
    { opId: 'r1', account: 'A', type: 'release', amount: 30, ref: 'f1', day: 'd', ts: 2, causes: ['f1'] },
    { opId: 'r2', account: 'A', type: 'release', amount: 30, ref: 'f1', day: 'd', ts: 3, causes: ['f1'] },
  ];
  fs.writeFileSync(h, ops.map((o) => JSON.stringify(o)).join('\n') + '\n');
  const r1 = run(['judge', '--history', h]);
  const r2 = run(['judge', '--history', h]);
  assert.equal(r1.status, 0);
  assert.equal(r1.stdout, r2.stdout, 'judge output is deterministic');
  const tied = JSON.parse(r1.stdout).accounts.A.tiedOptimal;
  assert.deepEqual(tied.sequences, [
    ['f1', 'r1', 'r2'],
    ['f1', 'r2', 'r1'],
  ]);
});
