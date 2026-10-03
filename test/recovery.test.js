'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Engine } = require('../src/engine');
const { recover } = require('../src/wal');
const { MonitorError } = require('../src/errors');

function tmpPaths() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mon-rec-'));
  return {
    dir,
    walPath: path.join(dir, 'mon.wal'),
    chkPath: path.join(dir, 'mon.chk'),
  };
}

test('acceptance 3: crash before checkpoint recovers to the last complete batch', () => {
  const { walPath, chkPath } = tmpPaths();
  const pattern = 'arm fire';
  let engine = Engine.open({ walPath, chkPath, pattern });
  engine.batch([{ id: 'e1', type: 'arm' }]);
  engine.batch([{ id: 'e2', type: 'reset' }]);
  engine.batch([{ id: 'e3', type: 'fire' }]);
  const before = engine.status();
  const r = engine.crash(); // no checkpoint was ever written
  assert.equal(r.seq, 3); // last complete batch
  assert.equal(r.hash, before.hash);
  assert.equal(r.state, before.state);
  assert.equal(r.replayed, 3);
  engine.close();
});

test('crash after checkpoint replays WAL past the checkpoint', () => {
  const { walPath, chkPath } = tmpPaths();
  const pattern = 'arm fire';
  const engine = Engine.open({ walPath, chkPath, pattern });
  engine.batch([{ id: 'e1', type: 'arm' }]);
  engine.checkpoint();
  engine.batch([{ id: 'e2', type: 'fire' }]); // WAL ahead of checkpoint: the fault point
  const before = engine.status();
  const r = engine.crash();
  assert.equal(r.seq, 2);
  assert.equal(r.hash, before.hash);
  assert.equal(r.state, 'VIOLATION');
  engine.close();
});

test('torn final WAL record is truncated, state stays consistent', () => {
  const { walPath, chkPath } = tmpPaths();
  const pattern = 'arm fire';
  const engine = Engine.open({ walPath, chkPath, pattern });
  engine.batch([{ id: 'e1', type: 'arm' }]);
  engine.batch([{ id: 'e2', type: 'reset' }]);
  const before = engine.status();
  const r = engine.crash({ torn: true }); // crash mid-write of the next record
  assert.equal(r.seq, 2);
  assert.equal(r.hash, before.hash);
  // WAL keeps working after truncation.
  const b = engine.batch([{ id: 'e3', type: 'fire' }]);
  assert.equal(b.seq, 3);
  const again = engine.crash();
  assert.equal(again.seq, 3);
  assert.equal(again.hash, b.hash);
  engine.close();
});

test('acceptance 2: backfill after a confirmed violation never revokes it', () => {
  const { walPath, chkPath } = tmpPaths();
  const pattern = 'arm fire';
  const engine = Engine.open({ walPath, chkPath, pattern });
  engine.batch([{ id: 'e1', type: 'arm' }]);
  const v = engine.batch([{ id: 'e2', type: 'fire' }]);
  assert.equal(v.state, 'VIOLATION');
  engine.checkpoint();
  // Late-arriving ("backfilled") events, including across a crash.
  engine.batch([{ id: 'e3', type: 'reset' }]);
  engine.crash();
  const late = engine.batch([{ id: 'e4', type: 'disarm' }]);
  assert.equal(late.state, 'VIOLATION');
  assert.equal(engine.status().state, 'VIOLATION');
  engine.close();
});

test('sequence gap in the WAL aborts recovery with exit code 12', () => {
  const { walPath, chkPath } = tmpPaths();
  const pattern = 'a b';
  const engine = Engine.open({ walPath, chkPath, pattern });
  engine.batch([{ id: 'e1', type: 'a' }]);
  engine.batch([{ id: 'e2', type: 'b' }]);
  engine.close();
  // Remove the first record, leaving a gap (starts at seq 2).
  const lines = fs.readFileSync(walPath, 'utf8').trim().split('\n');
  fs.writeFileSync(walPath, `${lines[1]}\n`);
  assert.throws(
    () => recover({ walPath, chkPath, pattern }),
    (e) => e instanceof MonitorError && e.code === 'SEQ_GAP' && e.exitCode === 12,
  );
});

test('hash mismatch in the WAL aborts recovery with exit code 12', () => {
  const { walPath, chkPath } = tmpPaths();
  const pattern = 'a b';
  const engine = Engine.open({ walPath, chkPath, pattern });
  engine.batch([{ id: 'e1', type: 'a' }]);
  engine.batch([{ id: 'e2', type: 'b' }]);
  engine.close();
  const lines = fs.readFileSync(walPath, 'utf8').trim().split('\n');
  const tampered = JSON.parse(lines[1]);
  tampered.events = [{ id: 'e2', type: 'a' }]; // tamper without re-hashing
  fs.writeFileSync(walPath, `${lines[0]}\n${JSON.stringify(tampered)}\n`);
  assert.throws(
    () => recover({ walPath, chkPath, pattern }),
    (e) => e instanceof MonitorError && e.code === 'HASH_MISMATCH' && e.exitCode === 12,
  );
});

test('corrupt checkpoint hash is detected', () => {
  const { walPath, chkPath } = tmpPaths();
  const pattern = 'a b';
  const engine = Engine.open({ walPath, chkPath, pattern });
  engine.batch([{ id: 'e1', type: 'a' }]);
  engine.checkpoint();
  engine.close();
  const chk = JSON.parse(fs.readFileSync(chkPath, 'utf8'));
  chk.hash = '0'.repeat(64);
  fs.writeFileSync(chkPath, JSON.stringify(chk));
  assert.throws(
    () => recover({ walPath, chkPath, pattern }),
    (e) => e instanceof MonitorError && e.code === 'HASH_MISMATCH' && e.exitCode === 12,
  );
});

test('recovery is deterministic: two recoveries agree exactly', () => {
  const { walPath, chkPath } = tmpPaths();
  const pattern = 'a (b|c) d';
  const engine = Engine.open({ walPath, chkPath, pattern });
  engine.batch([{ id: 'e1', type: 'a' }]);
  engine.batch([{ id: 'e2', type: 'b' }, { id: 'e3', type: 'c' }]);
  engine.checkpoint();
  engine.batch([{ id: 'e4', type: 'd' }]);
  const r1 = engine.crash();
  const r2 = engine.crash();
  assert.deepEqual(r1, r2);
  engine.close();
});
