'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { canonical, hashEvent } = require('../lib/ledger');

const CLI = path.join(__dirname, '..', 'cli.js');

// The sandbox used for these tests cannot capture child pipes, so stdout and
// stderr are redirected to files and read back.
function run(args, cwd) {
  const outPath = path.join(cwd, '.stdout');
  const errPath = path.join(cwd, '.stderr');
  const out = fs.openSync(outPath, 'w');
  const err = fs.openSync(errPath, 'w');
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, stdio: ['ignore', out, err] });
  fs.closeSync(out);
  fs.closeSync(err);
  return {
    status: r.status,
    stdout: fs.readFileSync(outPath, 'utf8'),
    stderr: fs.readFileSync(errPath, 'utf8'),
  };
}

function ok(args, cwd) {
  const r = run(args, cwd);
  assert.equal(r.status, 0, `expected success, got ${r.status}: ${r.stderr}`);
  assert.equal(r.stderr, '');
  return JSON.parse(r.stdout);
}

function err(args, cwd, code) {
  const r = run(args, cwd);
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stdout}`);
  assert.equal(r.stdout, '');
  assert.deepEqual(JSON.parse(r.stderr), { error: code });
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-cli-'));
}

test('acceptance 1: A settles, B merges and adjusts, balances and hash chain agree', () => {
  const dir = tmpdir();
  const a = path.join(dir, 'a.json');
  const b = path.join(dir, 'b.json');

  const settle = ok(['append', a, JSON.stringify({ replica: 'A', type: 'settle', paymentId: 'p1', amount: 100 })], dir);
  fs.writeFileSync(path.join(dir, 'ex1.json'), JSON.stringify(ok(['dump', a], dir)));
  const merge1 = ok(['merge', b, path.join(dir, 'ex1.json')], dir);
  assert.deepEqual(merge1.added, [settle.hash]);

  const adjust = ok(['append', b, JSON.stringify({ replica: 'B', type: 'adjust', paymentId: 'p1', amount: 150 })], dir);
  assert.deepEqual(adjust.preds, [settle.hash]);
  fs.writeFileSync(path.join(dir, 'ex2.json'), JSON.stringify(ok(['dump', b], dir)));
  const merge2 = ok(['merge', a, path.join(dir, 'ex2.json')], dir);
  assert.deepEqual(merge2.added, [adjust.hash]);
  assert.deepEqual(merge2.duplicates, [settle.hash]);

  const certA = ok(['cert', a], dir);
  const certB = ok(['cert', b], dir);
  assert.deepEqual(certA, certB);
  assert.deepEqual(certA.balances, { p1: 150 });
  assert.deepEqual(certA.frontier, [adjust.hash]);

  // hash chain: every event hash recomputes from content and preds are linked
  const events = ok(['dump', a], dir);
  const byHash = new Map(events.map((e) => [e.hash, e]));
  for (const e of events) {
    const body = { replica: e.replica, type: e.type, paymentId: e.paymentId, amount: e.amount, clock: e.clock, preds: e.preds };
    assert.equal(hashEvent(body), e.hash);
    for (const p of e.preds) assert.ok(byHash.has(p));
  }
  // entriesHash commits to the full set of event hashes
  const expected = crypto.createHash('sha256').update(canonical(events.map((e) => e.hash).sort())).digest('hex');
  assert.equal(certA.entriesHash, expected);
});

test('acceptance 2: concurrent different amounts -> conflict, no certificate', () => {
  const dir = tmpdir();
  const a = path.join(dir, 'a.json');
  const b = path.join(dir, 'b.json');

  ok(['append', a, JSON.stringify({ replica: 'A', type: 'settle', paymentId: 'p1', amount: 100 })], dir);
  fs.writeFileSync(path.join(dir, 'ex1.json'), JSON.stringify(ok(['dump', a], dir)));
  ok(['merge', b, path.join(dir, 'ex1.json')], dir);

  // concurrent adjustments on both replicas with different amounts
  ok(['append', a, JSON.stringify({ replica: 'A', type: 'adjust', paymentId: 'p1', amount: 150 })], dir);
  ok(['append', b, JSON.stringify({ replica: 'B', type: 'adjust', paymentId: 'p1', amount: 200 })], dir);

  fs.writeFileSync(path.join(dir, 'ex2.json'), JSON.stringify(ok(['dump', b], dir)));
  ok(['merge', a, path.join(dir, 'ex2.json')], dir);
  fs.writeFileSync(path.join(dir, 'ex3.json'), JSON.stringify(ok(['dump', a], dir)));
  ok(['merge', b, path.join(dir, 'ex3.json')], dir);

  err(['cert', a], dir, 'conflict');
  err(['cert', b], dir, 'conflict');
});

test('acceptance 3: unknown-predecessor and stale-clock are reported separately', () => {
  const dir = tmpdir();
  const a = path.join(dir, 'a.json');
  const b = path.join(dir, 'b.json');

  ok(['append', a, JSON.stringify({ replica: 'A', type: 'settle', paymentId: 'p1', amount: 100 })], dir);
  const e2 = ok(['append', a, JSON.stringify({ replica: 'A', type: 'adjust', paymentId: 'p1', amount: 120 })], dir);

  // unknown-predecessor: B receives e2 without its predecessor e1
  fs.writeFileSync(path.join(dir, 'gap.json'), JSON.stringify([e2]));
  err(['merge', b, path.join(dir, 'gap.json')], dir, 'unknown-predecessor');
  assert.ok(!fs.existsSync(b), 'failed merge must not create the ledger file');

  // stale-clock: A rolls back and emits a different event with the same A-seq
  const rolledBack = {
    replica: 'A',
    type: 'adjust',
    paymentId: 'p2',
    amount: 5,
    clock: { A: 2 },
    preds: e2.preds,
  };
  rolledBack.hash = hashEvent(rolledBack);
  fs.writeFileSync(path.join(dir, 'rollback.json'), JSON.stringify([rolledBack]));
  err(['merge', a, path.join(dir, 'rollback.json')], dir, 'stale-clock');

  // ledger remains usable and consistent afterwards
  const cert = ok(['cert', a], dir);
  assert.deepEqual(cert.balances, { p1: 120 });
});

test('merge is idempotent and works with dump round-trip', () => {
  const dir = tmpdir();
  const a = path.join(dir, 'a.json');
  const b = path.join(dir, 'b.json');
  ok(['append', a, JSON.stringify({ replica: 'A', type: 'settle', paymentId: 'p1', amount: 100 })], dir);
  fs.writeFileSync(path.join(dir, 'ex.json'), JSON.stringify(ok(['dump', a], dir)));
  ok(['merge', b, path.join(dir, 'ex.json')], dir);
  const again = ok(['merge', b, path.join(dir, 'ex.json')], dir);
  assert.equal(again.added.length, 0);
  assert.equal(again.duplicates.length, 1);
  assert.deepEqual(ok(['cert', a], dir), ok(['cert', b], dir));
});

test('malformed input and usage errors exit 1 with JSON error', () => {
  const dir = tmpdir();
  err(['append', path.join(dir, 'x.json'), 'not-json'], dir, 'invalid-json');
  err(['cert', path.join(dir, 'missing.json'), 'extra'], dir, 'usage');
  err(['nope'], dir, 'usage');
});
