import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Ledger } from '../src/ledger.js';
import { tempDir, balancesOf } from './helpers.js';

function corruptLastBytes(dir, count = 3) {
  const logPath = join(dir, 'events.log');
  const buf = readFileSync(logPath);
  for (let i = 1; i <= count; i += 1) buf[buf.length - i] ^= 0xFF;
  writeFileSync(logPath, buf);
}

test('corrupt tail chunk raises E_CRC, recover truncates, savepoint state restorable', () => {
  const dir = tempDir();
  const ledger = Ledger.open(dir);
  ledger.execute('receive', { batch: 'A', qty: 100 }, 'c1');
  ledger.savepoint('S');
  ledger.snapshot();
  ledger.execute('receive', { batch: 'A', qty: 50 }, 'c2');
  ledger.execute('issue', { batch: 'A', qty: 30 }, 'c3');
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const savepointHash = manifest.savepoints.S.stateHash;

  corruptLastBytes(dir);
  assert.throws(() => Ledger.open(dir), (err) => err.code === 'E_CRC');

  const recovery = Ledger.recover(dir);
  assert.equal(recovery.truncated, true);

  const recovered = Ledger.open(dir);
  assert.equal(recovered.status().batches.A.onHand, 150, 'intact tail chunk kept, corrupt one dropped');
  assert.deepEqual(recovered.execute('receive', { batch: 'A', qty: 50 }, 'c2').onHand, 150);

  const certificate = recovered.rollback('S');
  assert.equal(certificate.savepoint, 'S');
  assert.equal(recovered.status().batches.A.onHand, 100);
  const manifestAfter = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  assert.equal(manifestAfter.savepoints.S.stateHash, savepointHash);
  assert.equal(certificate.stateHashAfter, savepointHash);
});

test('truncated partial tail chunk is reported as E_CRC and recoverable', () => {
  const dir = tempDir();
  const ledger = Ledger.open(dir);
  ledger.execute('receive', { batch: 'T', qty: 7 }, 't1');
  ledger.savepoint('S');
  const logPath = join(dir, 'events.log');
  const size = readFileSync(logPath).length;
  ledger.execute('receive', { batch: 'T', qty: 3 }, 't2');
  // simulate crash mid-append: cut the last chunk in half
  const buf = readFileSync(logPath);
  writeFileSync(logPath, buf.subarray(0, size + 5));

  assert.throws(() => Ledger.open(dir), (err) => err.code === 'E_CRC');
  Ledger.recover(dir);
  const recovered = Ledger.open(dir);
  assert.equal(recovered.status().batches.T.onHand, 7);
});

test('stray manifest tmp file (crash before rename) keeps previous snapshot in effect', () => {
  const dir = tempDir();
  const ledger = Ledger.open(dir);
  ledger.execute('receive', { batch: 'A', qty: 10 }, 's1');
  ledger.snapshot();
  ledger.execute('receive', { batch: 'A', qty: 5 }, 's2');

  const manifestBefore = readFileSync(join(dir, 'manifest.json'), 'utf8');
  // simulate crash between tmp write and rename of the next manifest update
  writeFileSync(join(dir, 'manifest.json.tmp-9999'), '{"broken":');
  assert.equal(readFileSync(join(dir, 'manifest.json'), 'utf8'), manifestBefore);

  const reopened = Ledger.open(dir);
  assert.equal(reopened.status().batches.A.onHand, 15);
  assert.equal(reopened.manifest.snapshots.length, 1);
});

test('missing snapshot file falls back to earlier snapshot or full replay', () => {
  const dir = tempDir();
  const ledger = Ledger.open(dir);
  ledger.execute('receive', { batch: 'A', qty: 10 }, 'm1');
  ledger.snapshot();
  ledger.execute('receive', { batch: 'A', qty: 5 }, 'm2');
  ledger.snapshot();

  const snaps = readdirSync(join(dir, 'snapshots')).sort();
  assert.equal(snaps.length, 2);
  rmSync(join(dir, 'snapshots', snaps[1]));

  const reopened = Ledger.open(dir);
  assert.equal(reopened.status().batches.A.onHand, 15);

  rmSync(join(dir, 'snapshots', snaps[0]));
  const fullReplay = Ledger.open(dir);
  assert.equal(fullReplay.status().batches.A.onHand, 15);
});

test('snapshot open path matches full replay', () => {
  const dir = tempDir();
  const ledger = Ledger.open(dir);
  ledger.execute('receive', { batch: 'P', qty: 0 }, 'n0');
  ledger.execute('receive', { batch: 'A', qty: 30, parent: 'P' }, 'n1');
  ledger.execute('receive', { batch: 'B', qty: 70, parent: 'P' }, 'n2');
  ledger.execute('reserve', { batch: 'A', qty: 10 }, 'n3');
  ledger.snapshot();
  ledger.execute('issue', { batch: 'P', qty: 45 }, 'n4');
  ledger.savepoint('S');
  ledger.execute('receive', { batch: 'B', qty: 1 }, 'n5');
  ledger.rollback('S');

  const viaSnapshot = Ledger.open(dir);
  assert.deepEqual(balancesOf(viaSnapshot.status()), balancesOf(ledger.status()));
});
