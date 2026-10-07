import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, loadLedger } from '../src/store.js';
import { Frac } from '../src/frac.js';

function tmpfile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pay-')), 'log.txt');
}

function seedLog(file) {
  const store = new Store(file);
  store.init(Frac.parse('500/1'));
  store.append({ type: 'freeze', tx: 't1', amt: '100/1' });
  store.append({ type: 'capture', tx: 't1', amt: '40/1', id: 'c1' });
  store.append({ type: 'branch', name: 'b1', fromEvent: 2 });
  store.append({ type: 'void', tx: 't1' });
  return store;
}

// ---------- acceptance 3 ----------
test('acceptance 3: power loss after record, before checksum -> truncate + consistent replay', () => {
  const file = tmpfile();
  seedLog(file);
  const before = loadLedger(new Store(file)).ledger.snapshot();

  // Fault injection: record line written, checksum line never written.
  fs.appendFileSync(file, JSON.stringify({ type: 'reverse', captureId: 'c1' }) + '\n');

  const { ledger, summary } = loadLedger(new Store(file));
  assert.equal(summary.truncated, true);
  assert.ok(summary.droppedBytes > 0);
  assert.equal(summary.validRecords, 5); // init + 4 ops
  assert.deepEqual(ledger.snapshot(), before); // orphan record discarded

  // File was physically truncated: a second load is clean and identical.
  const again = loadLedger(new Store(file));
  assert.equal(again.summary.truncated, false);
  assert.deepEqual(again.ledger.snapshot(), before);

  // And new records can be appended after recovery without corruption.
  const store = new Store(file);
  store.append({ type: 'reverse', captureId: 'c1' });
  const third = loadLedger(new Store(file));
  assert.equal(third.summary.truncated, false);
  assert.equal(third.ledger.snapshot().debt, '0/1');
});

test('recovery: torn checksum line and corrupted checksum both truncate', () => {
  // torn checksum (partial write)
  const f1 = tmpfile();
  seedLog(f1);
  const good = loadLedger(new Store(f1)).ledger.snapshot();
  fs.appendFileSync(f1, JSON.stringify({ type: 'undo' }) + '\n' + 'sha256:dead');
  const r1 = loadLedger(new Store(f1));
  assert.equal(r1.summary.truncated, true);
  assert.deepEqual(r1.ledger.snapshot(), good);

  // full-length but wrong checksum (bit rot)
  const f2 = tmpfile();
  seedLog(f2);
  const line = JSON.stringify({ type: 'undo' });
  fs.appendFileSync(f2, line + '\n' + 'sha256:' + '0'.repeat(64) + '\n');
  const r2 = loadLedger(new Store(f2));
  assert.equal(r2.summary.truncated, true);
  assert.deepEqual(r2.ledger.snapshot(), good);

  // garbage bytes at tail (partial record write, no newline)
  const f3 = tmpfile();
  seedLog(f3);
  fs.appendFileSync(f3, '{"type":"free');
  const r3 = loadLedger(new Store(f3));
  assert.equal(r3.summary.truncated, true);
  assert.deepEqual(r3.ledger.snapshot(), good);
});

test('replay of the persisted log reconstructs branch/merge/undo state', () => {
  const file = tmpfile();
  const store = new Store(file);
  store.init(Frac.parse('1000/1'));
  const ops = [
    { type: 'freeze', tx: 't1', amt: '100/1' }, // seq 1
    { type: 'branch', name: 'b1', fromEvent: 1 },
    { type: 'capture', tx: 't1', amt: '30/1', id: 'cb' }, // on b1
    { type: 'checkout', name: 'main' },
    { type: 'capture', tx: 't1', amt: '20/1', id: 'cm' },
    { type: 'merge', branch: 'b1' },
    { type: 'checkout', name: 'b1' },
    { type: 'undo' },
    { type: 'checkout', name: 'main' },
  ];
  for (const op of ops) store.append(op);
  const { ledger } = loadLedger(new Store(file));
  const s = ledger.snapshot();
  assert.equal(s.branch, 'main');
  assert.equal(s.debt, '50/1'); // merged ancestor events survive child undo
  assert.equal(s.available, '900/1'); // 1000 - 50 frozen - 50 debt
});

test('E_IO on unreadable/missing log', () => {
  const missing = path.join(os.tmpdir(), `pay-nope-${process.pid}`, 'x.log');
  assert.throws(() => loadLedger(new Store(missing)), (e) => e.code === 'E_IO');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pay-'));
  assert.throws(() => loadLedger(new Store(dir)), (e) => e.code === 'E_IO');
});
