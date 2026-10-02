'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeTmpDir, writeJournal, runCli, genJournal, mulberry32 } = require('./helpers');
const { runApply } = require('../lib/apply');

const ROWS = 10000;
const BATCH = 500;

class SimulatedCrash extends Error {}

function crashHook(point) {
  const [phase, idx] = point.split(':');
  return (p, i) => {
    if (p === phase && String(i) === String(idx)) throw new SimulatedCrash(`kill -9 at ${point}`);
  };
}

function paths(dir) {
  return {
    journal: path.join(dir, 'journal.ndjson'),
    snap: path.join(dir, 'snap.json'),
    cs: path.join(dir, 'cs.json'),
    db: path.join(dir, 'db.json'),
    cp: path.join(dir, 'cp.json'),
    cert: path.join(dir, 'cert.json'),
  };
}

function scanDir(p) {
  const scan = runCli(['scan', '--journal', p.journal, '--snapshot', p.snap, '--changeset', p.cs]);
  assert.equal(scan.status, 0, scan.stderr);
}

function applyOpts(p, resume, hook, batch = BATCH) {
  return {
    changesetPath: p.cs, dbPath: p.db, checkpointPath: p.cp, certPath: p.cert,
    batchSize: batch, resume, hook,
  };
}

// Abrupt termination is simulated by a hook throwing between durable writes;
// every runApply call rebuilds purely from on-disk state, exactly like a fresh
// process after kill -9. Real kill -9 end-to-end proof: scripts/e2e_crash.sh.
test('10k rows, 3x crash at random points, recovered hash equals one-shot run', { timeout: 120000 }, () => {
  const seed = 20261003;
  const records = genJournal(seed, ROWS);
  assert.equal(records.length, ROWS);

  const dirA = makeTmpDir('crash-oneshot-');
  const pa = paths(dirA);
  writeJournal(dirA, records);
  scanDir(pa);
  const oneShot = runCli(['apply', '--changeset', pa.cs, '--db', pa.db, '--checkpoint', pa.cp, '--cert', pa.cert, '--batch', String(BATCH)]);
  assert.equal(oneShot.status, 0, oneShot.stderr);

  const dirB = makeTmpDir('crash-resume-');
  const pb = paths(dirB);
  writeJournal(dirB, records);
  scanDir(pb);
  const batchCount = Math.ceil(ROWS / BATCH);

  const rng = mulberry32(777);
  const k1 = Math.floor(rng() * (batchCount - 1));
  const k2 = k1 + Math.floor(rng() * (batchCount - k1));
  const crashPoints = [
    `db:${k1}`, // after db write of batch k1, before its checkpoint
    `checkpoint:${k2}`, // after checkpoint of batch k2 (reached on resume)
    'cert:0', // after final checkpoint, before cert
  ];

  let kills = 0;
  let first = true;
  for (const point of crashPoints) {
    const hook = crashHook(point);
    assert.throws(
      () => runApply(applyOpts(pb, !first, hook)),
      (e) => e instanceof SimulatedCrash,
      `expected crash at ${point}`,
    );
    first = false;
    kills += 1;
  }
  assert.equal(kills, 3);

  const final = runApply(applyOpts(pb, true, null));
  assert.ok(['ok', 'already-committed'].includes(final.status), final.status);

  const certA = JSON.parse(fs.readFileSync(pa.cert, 'utf8'));
  const certB = JSON.parse(fs.readFileSync(pb.cert, 'utf8'));
  assert.equal(certB.merkleRoot, certA.merkleRoot, 'merkle root must match one-shot run');
  assert.equal(certB.stateHash, certA.stateHash, 'state hash must match one-shot run');
  assert.deepEqual(certB.coverage, certA.coverage);
  assert.equal(fs.readFileSync(pb.db, 'utf8'), fs.readFileSync(pa.db, 'utf8'), 'db files must be byte-identical');
});

test('crash after db write but before checkpoint: uncommitted batch is redone', () => {
  const dir = makeTmpDir('crash-uncommitted-');
  const p = paths(dir);
  writeJournal(dir, genJournal(9, 100));
  scanDir(p);
  const batchCount = Math.ceil(100 / 10);

  assert.throws(
    () => runApply(applyOpts(p, false, crashHook(`db:${batchCount - 1}`), 10)),
    SimulatedCrash,
  );

  const cp = JSON.parse(fs.readFileSync(p.cp, 'utf8'));
  assert.equal(cp.committedBatches, batchCount - 1, 'last batch must be uncommitted');
  assert.ok(!fs.existsSync(p.cert), 'cert must not exist yet');

  const resumed = runApply(applyOpts(p, true, null, 10));
  assert.equal(resumed.redone, 1, 'exactly the uncommitted batch is redone');
  assert.ok(fs.existsSync(p.cert));
});

test('crash after checkpoint but before cert: committed work is not redone', () => {
  const dir = makeTmpDir('crash-committed-');
  const p = paths(dir);
  writeJournal(dir, genJournal(11, 100));
  scanDir(p);

  assert.throws(
    () => runApply(applyOpts(p, false, crashHook('cert:0'), 10)),
    SimulatedCrash,
  );
  assert.ok(!fs.existsSync(p.cert), 'cert missing after crash');

  const dbBefore = fs.readFileSync(p.db, 'utf8');
  const cpBefore = fs.readFileSync(p.cp, 'utf8');

  const resumed = runApply(applyOpts(p, true, null, 10));
  assert.equal(resumed.status, 'already-committed');
  assert.equal(resumed.redone, 0, 'committed batches must not be redone');
  assert.equal(fs.readFileSync(p.db, 'utf8'), dbBefore, 'db untouched');
  assert.equal(fs.readFileSync(p.cp, 'utf8'), cpBefore, 'checkpoint untouched');
  assert.ok(fs.existsSync(p.cert), 'cert written by resume');
});
