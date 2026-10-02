'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { mulberry32, mkTmp, writeJournal, runCli } = require('./helper');
const { sha256, canonical, readJson } = require('../lib/util');

function genRows(n, rng) {
  const rows = [];
  const open = [];
  for (let i = 0; i < n; i++) {
    if (rng() < 0.2 && open.length > 0) {
      const idx = Math.floor(rng() * open.length);
      const id = open.splice(idx, 1)[0];
      rows.push({ id: 'u' + i, undo: id });
    } else {
      const id = 't' + i;
      rows.push({ id, account: 'acc' + (i % 37), amount_cents: 1 + Math.floor(rng() * 100000) });
      open.push(id);
    }
  }
  return rows;
}

test('10k rows, 3x kill -9, recovered hash equals one-shot run', () => {
  const rng = mulberry32(42);
  const rows = genRows(10000, rng);
  const root = mkTmp('ledger-crash-');
  const journal = path.join(root, 'journal.ndjson');
  writeJournal(journal, rows);

  // one-shot reference run
  const dirA = path.join(root, 'one-shot');
  let r = runCli(['scan', '--journal', journal, '--dir', dirA]);
  assert.strictEqual(r.status, 0, r.stderr);
  r = runCli(['apply', '--journal', journal, '--dir', dirA, '--batch', '500']);
  assert.strictEqual(r.status, 0, r.stderr);

  // crash run: three random kill -9 injections
  const dirB = path.join(root, 'crash');
  r = runCli(['scan', '--journal', journal, '--dir', dirB]);
  assert.strictEqual(r.status, 0, r.stderr);

  const crashRng = mulberry32(7);
  const batchNums = [];
  while (batchNums.length < 2) {
    const b = 1 + Math.floor(crashRng() * 19);
    if (!batchNums.includes(b)) batchNums.push(b);
  }
  batchNums.sort((a, b) => a - b);
  const points = [
    (crashRng() < 0.5 ? 'db:' : 'ckpt:') + batchNums[0],
    (crashRng() < 0.5 ? 'db:' : 'ckpt:') + batchNums[1],
    'pre-cert',
  ];

  for (const point of points) {
    // each apply first recovers the previous crash, then is killed -9 at the next random point
    r = runCli(['apply', '--journal', journal, '--dir', dirB, '--batch', '500'], { LEDGER_CRASH_AT: point });
    assert.strictEqual(r.signal, 'SIGKILL', 'expected kill -9 at ' + point + ', got ' + JSON.stringify(r));
  }
  // final recovery: last kill was pre-cert, so resume must only issue the cert
  r = runCli(['resume', '--journal', journal, '--dir', dirB, '--batch', '500']);
  assert.strictEqual(r.status, 0, 'resume failed: ' + r.stderr);
  const finalReport = JSON.parse(r.stdout);
  assert.strictEqual(finalReport.redoneEvents, 0, 'committed work must not be redone');
  assert.strictEqual(finalReport.batches, 0);

  const dbA = readJson(path.join(dirA, 'db.json'));
  const dbB = readJson(path.join(dirB, 'db.json'));
  assert.strictEqual(sha256(canonical(dbB)), sha256(canonical(dbA)), 'db hash mismatch after recovery');

  const certA = readJson(path.join(dirA, 'cert.json'));
  const certB = readJson(path.join(dirB, 'cert.json'));
  assert.strictEqual(certB.merkleRoot, certA.merkleRoot, 'merkle root mismatch after recovery');
  assert.strictEqual(certB.rowHash, certA.rowHash, 'row hash chain mismatch after recovery');
  assert.strictEqual(certB.from, 1);
  assert.strictEqual(certB.to, 10000);

  // cert command is idempotent and matches
  r = runCli(['cert', '--journal', journal, '--dir', dirB]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).merkleRoot, certA.merkleRoot);
});

test('crash points expose uncommitted-redo and committed-no-redo recovery', () => {
  const rng = mulberry32(99);
  const rows = genRows(2000, rng);
  const root = mkTmp('ledger-points-');
  const journal = path.join(root, 'journal.ndjson');
  writeJournal(journal, rows);
  const dir = path.join(root, 'state');
  assert.strictEqual(runCli(['scan', '--journal', journal, '--dir', dir]).status, 0);

  // crash after db write of batch 2, before checkpoint -> uncommitted, redoable
  let r = runCli(['apply', '--journal', journal, '--dir', dir, '--batch', '500'], { LEDGER_CRASH_AT: 'db:2' });
  assert.strictEqual(r.signal, 'SIGKILL');
  let db = readJson(path.join(dir, 'db.json'));
  let ck = readJson(path.join(dir, 'checkpoint.json'));
  assert.strictEqual(db.progress.appliedSeq, 1000);
  assert.strictEqual(ck.committedSeq, 500, 'checkpoint must lag behind db (uncommitted batch)');

  r = runCli(['resume', '--journal', journal, '--dir', dir, '--batch', '500']);
  assert.strictEqual(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.strictEqual(report.redoneEvents, 500, 'uncommitted batch must be redone');
  ck = readJson(path.join(dir, 'checkpoint.json'));
  assert.strictEqual(ck.committedSeq, 2000);

  // crash after final checkpoint, before cert -> committed, must NOT redo
  const dir2 = path.join(root, 'state2');
  assert.strictEqual(runCli(['scan', '--journal', journal, '--dir', dir2]).status, 0);
  r = runCli(['apply', '--journal', journal, '--dir', dir2, '--batch', '500'], { LEDGER_CRASH_AT: 'pre-cert' });
  assert.strictEqual(r.signal, 'SIGKILL');
  ck = readJson(path.join(dir2, 'checkpoint.json'));
  assert.strictEqual(ck.committedSeq, 2000);
  assert.ok(!fs.existsSync(path.join(dir2, 'cert.json')), 'cert must be missing after pre-cert kill');

  r = runCli(['resume', '--journal', journal, '--dir', dir2, '--batch', '500']);
  assert.strictEqual(r.status, 0, r.stderr);
  const report2 = JSON.parse(r.stdout);
  assert.strictEqual(report2.redoneEvents, 0, 'committed work must not be redone');
  assert.strictEqual(report2.batches, 0, 'no batch may be re-applied');
  assert.ok(fs.existsSync(path.join(dir2, 'cert.json')), 'cert regenerated');

  const db1 = readJson(path.join(dir, 'db.json'));
  const db2 = readJson(path.join(dir2, 'db.json'));
  assert.strictEqual(sha256(canonical(db1)), sha256(canonical(db2)));
});
