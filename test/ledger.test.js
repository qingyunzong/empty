import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Ledger, recoverLedger, distribute } from '../src/ledger.js';
import { scanLog } from '../src/log.js';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
}

function balanceOf(ledger, batch) {
  return ledger.balances().find((b) => b.batch === batch);
}

test('hierarchical issue consumes child batches proportionally (matches independent enumeration)', () => {
  const dir = tmp();
  const l = Ledger.init(dir);
  l.receive({ key: 'k1', batch: 'P', material: 'M', qty: 10 });
  l.receive({ key: 'k2', batch: 'C1', material: 'M', qty: 60, parent: 'P' });
  l.receive({ key: 'k3', batch: 'C2', material: 'M', qty: 40, parent: 'P' });

  const r = l.issue({ key: 'k4', batch: 'P', qty: 55 });
  assert.equal(r.ok, true);

  // independent enumeration: subtree stock P=10, C1=60, C2=40, total=110
  // shares of 55: P=floor(55*10/110)=5, C1=30, C2=20 (exact, no remainder)
  assert.deepEqual(r.detail.distribution, [
    { batch: 'P', qty: 5 },
    { batch: 'C1', qty: 30 },
    { batch: 'C2', qty: 20 },
  ]);
  assert.equal(balanceOf(l, 'P').available, 5);
  assert.equal(balanceOf(l, 'C1').available, 30);
  assert.equal(balanceOf(l, 'C2').available, 20);
  assert.equal(balanceOf(l, 'P').subtreeAvailable, 55);

  // replay from disk must reproduce identical state
  const l2 = Ledger.init(dir);
  assert.deepEqual(l2.balances(), l.balances());
});

test('proportional split remainder is deterministic (largest remainder, creation order ties)', () => {
  // 2 across three batches of 1 each: floors are 0, remainders tie -> first two by order
  const shares = distribute(2, [
    { id: 'a', avail: 1 },
    { id: 'b', avail: 1 },
    { id: 'c', avail: 1 },
  ]);
  assert.deepEqual(shares, [
    { batch: 'a', qty: 1 },
    { batch: 'b', qty: 1 },
    { batch: 'c', qty: 0 },
  ]);
  // 7 across [1, 3, 3]: floor(7/7*[1,3,3]) = [1,3,3] exact
  const exact = distribute(7, [
    { id: 'a', avail: 1 },
    { id: 'b', avail: 3 },
    { id: 'c', avail: 3 },
  ]);
  assert.deepEqual(exact, [
    { batch: 'a', qty: 1 },
    { batch: 'b', qty: 3 },
    { batch: 'c', qty: 3 },
  ]);
});

test('duplicate idempotency keys return the original result and never change stock', () => {
  const dir = tmp();
  const l = Ledger.init(dir);
  const first = l.receive({ key: 'k1', batch: 'B', material: 'M', qty: 10 });
  const again = l.receive({ key: 'k1', batch: 'B', material: 'M', qty: 10 });
  assert.equal(again.duplicate, true);
  assert.deepEqual({ ok: again.ok, code: again.code, detail: again.detail }, {
    ok: first.ok, code: first.code, detail: first.detail,
  });
  assert.equal(balanceOf(l, 'B').available, 10);

  // duplicates survive restart (key map rebuilt from log)
  const l2 = Ledger.init(dir);
  const third = l2.receive({ key: 'k1', batch: 'B', material: 'M', qty: 10 });
  assert.equal(third.duplicate, true);
  assert.equal(balanceOf(l2, 'B').available, 10);
  assert.equal(l2.records.length, 1); // no extra records appended

  // failed results are idempotent too
  const fail1 = l2.issue({ key: 'k9', batch: 'B', qty: 999 });
  assert.equal(fail1.code, 'E_STOCK');
  const l3 = Ledger.init(dir);
  const fail2 = l3.issue({ key: 'k9', batch: 'B', qty: 999 });
  assert.equal(fail2.duplicate, true);
  assert.equal(fail2.code, 'E_STOCK');
  assert.equal(balanceOf(l3, 'B').available, 10);
});

test('reservation budget: over-budget issue and over-available reserve return E_STOCK', () => {
  const dir = tmp();
  const l = Ledger.init(dir);
  l.receive({ key: 'k1', batch: 'B', material: 'M', qty: 100 });
  const rs = l.reserve({ key: 'r1', batch: 'B', qty: 30 });
  assert.equal(rs.ok, true);
  assert.equal(balanceOf(l, 'B').reserved, 30);

  // issue beyond reserved budget
  const over = l.issue({ key: 'i1', batch: 'B', qty: 40 });
  assert.equal(over.ok, false);
  assert.equal(over.code, 'E_STOCK');
  assert.equal(balanceOf(l, 'B').available, 100);

  // issue within budget consumes the reservation
  const ok = l.issue({ key: 'i2', batch: 'B', qty: 30 });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.detail.consumed, [{ reservation: 'r1', qty: 30 }]);
  assert.equal(balanceOf(l, 'B').reserved, 0);
  assert.equal(balanceOf(l, 'B').available, 70);

  // reserve beyond available
  const tooMuch = l.reserve({ key: 'r2', batch: 'B', qty: 71 });
  assert.equal(tooMuch.code, 'E_STOCK');
  const fits = l.reserve({ key: 'r3', batch: 'B', qty: 70 });
  assert.equal(fits.ok, true);

  // issue beyond physical stock
  const noStock = l.issue({ key: 'i3', batch: 'C', qty: 1 });
  assert.equal(noStock.code, 'E_STOCK');
});

test('return restores stock and cannot exceed issued quantity', () => {
  const dir = tmp();
  const l = Ledger.init(dir);
  l.receive({ key: 'k1', batch: 'B', material: 'M', qty: 50 });
  l.issue({ key: 'k2', batch: 'B', qty: 20 });
  const ret = l.returnMaterial({ key: 'k3', batch: 'B', qty: 10 });
  assert.equal(ret.ok, true);
  assert.equal(balanceOf(l, 'B').available, 40);
  const tooMuch = l.returnMaterial({ key: 'k4', batch: 'B', qty: 15 });
  assert.equal(tooMuch.code, 'E_STOCK');
  assert.equal(balanceOf(l, 'B').available, 40);
});

test('rollback to savepoint compensates hierarchically, keeps old records, then appends deterministically', () => {
  const dir = tmp();
  const l = Ledger.init(dir);
  l.receive({ key: 'k1', batch: 'P', material: 'M', qty: 100 });
  l.receive({ key: 'k2', batch: 'C1', material: 'M', qty: 60, parent: 'P' });
  l.receive({ key: 'k3', batch: 'C2', material: 'M', qty: 40, parent: 'P' });
  assert.equal(l.savepoint('s1').ok, true);
  const atSavepoint = l.balances();

  l.issue({ key: 'k4', batch: 'P', qty: 60 }); // P:30 C1:18 C2:12
  l.reserve({ key: 'k5', batch: 'C1', qty: 10 });
  assert.notDeepEqual(l.balances(), atSavepoint);

  const recordsBefore = l.records.length;
  const rb = l.rollback('s1');
  assert.equal(rb.ok, true);
  assert.equal(rb.certificate.savepoint, 's1');
  assert.equal(rb.certificate.count, 2);
  assert.deepEqual(rb.certificate.keys, ['k4', 'k5']);
  assert.match(rb.certificate.hash, /^[0-9a-f]{64}$/);

  // state restored exactly; old records not erased (log only grew)
  assert.deepEqual(l.balances(), atSavepoint);
  assert.ok(l.records.length > recordsBefore);

  // state survives replay
  const l2 = Ledger.init(dir);
  assert.deepEqual(l2.balances(), atSavepoint);
  assert.equal(l2.certificates.length, 1);

  // appending after rollback is deterministic
  const again = l2.issue({ key: 'k6', batch: 'P', qty: 100 });
  assert.equal(again.ok, true);
  assert.deepEqual(again.detail.distribution, [
    { batch: 'P', qty: 50 },
    { batch: 'C1', qty: 30 },
    { batch: 'C2', qty: 20 },
  ]);
  const l3 = Ledger.init(dir);
  assert.deepEqual(l3.balances(), l2.balances());

  // second rollback to same savepoint only compensates the new event
  const rb2 = l3.rollback('s1');
  assert.deepEqual(rb2.certificate.keys, ['k6']);
  assert.deepEqual(l3.balances(), atSavepoint);
});

test('rollback to a nonexistent savepoint returns E_SAVEPOINT', () => {
  const dir = tmp();
  const l = Ledger.init(dir);
  l.receive({ key: 'k1', batch: 'B', material: 'M', qty: 5 });
  const r = l.rollback('nope');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E_SAVEPOINT');
  assert.equal(balanceOf(l, 'B').available, 5);
});

test('rollback reverses receive of a child batch created after the savepoint', () => {
  const dir = tmp();
  const l = Ledger.init(dir);
  l.receive({ key: 'k1', batch: 'P', material: 'M', qty: 100 });
  l.savepoint('s1');
  l.receive({ key: 'k2', batch: 'C1', material: 'M', qty: 60, parent: 'P' });
  l.issue({ key: 'k3', batch: 'P', qty: 80 }); // consumes P and C1
  const rb = l.rollback('s1');
  assert.equal(rb.certificate.count, 2);
  assert.deepEqual(l.balances(), [
    { batch: 'P', material: 'M', parent: null, received: 100, issued: 0, available: 100, reserved: 0, subtreeAvailable: 100 },
  ]);
  // batch created after the savepoint is gone again
  assert.equal(l.issue({ key: 'k4', batch: 'C1', qty: 1 }).code, 'E_STOCK');
});

test('corrupt tail block: open fails with E_CRC, recover restores savepoint-consistent state', () => {
  const dir = tmp();
  const l = Ledger.init(dir);
  l.receive({ key: 'k1', batch: 'B', material: 'M', qty: 100 });
  l.savepoint('s1');
  const atSavepoint = l.balances();
  l.receive({ key: 'k2', batch: 'B', material: 'M', qty: 50 });
  l.receive({ key: 'k3', batch: 'B', material: 'M', qty: 25 });

  // corrupt the first block written after the savepoint (k2); everything
  // from there on (k2, k3) becomes unreadable
  const logPath = path.join(dir, 'events.log');
  const k2Offset = scanLog(logPath).records.find((r) => r.record.event.key === 'k2').offset;
  const fd = fs.openSync(logPath, 'r+');
  fs.writeSync(fd, Buffer.from([0xaa]), 0, 1, k2Offset + 6);
  fs.closeSync(fd);

  assert.throws(() => Ledger.init(dir), (err) => err.code === 'E_CRC');

  const rec = recoverLedger(dir);
  assert.equal(rec.recovered, true);
  assert.equal(rec.reason, 'crc-mismatch');

  const l2 = Ledger.init(dir);
  assert.deepEqual(l2.balances(), atSavepoint);
  assert.ok(l2.savepoints.has('s1'));
  // ledger is writable again after recovery
  assert.equal(l2.receive({ key: 'k4', batch: 'B', material: 'M', qty: 7 }).ok, true);
  assert.equal(balanceOf(l2, 'B').available, 107);
});

test('snapshot manifest: tmp+rename publish; crash before rename keeps previous snapshot', () => {
  const dir = tmp();
  const l = Ledger.init(dir);
  l.receive({ key: 'k1', batch: 'B', material: 'M', qty: 10 });
  l.savepoint('s1');
  const manifest1 = JSON.parse(fs.readFileSync(path.join(dir, 'snapshot.json'), 'utf8'));
  assert.deepEqual(manifest1.savepoints.map((s) => s.name), ['s1']);
  assert.equal(fs.existsSync(path.join(dir, 'snapshot.json.tmp')), false);

  // simulate crash mid-snapshot: garbage tmp file, rename never happens
  fs.writeFileSync(path.join(dir, 'snapshot.json.tmp'), '{"version":1,"savepoi');
  l.receive({ key: 'k2', batch: 'B', material: 'M', qty: 5 });

  // reopen: previous manifest still intact, tmp ignored, log is source of truth
  const l2 = Ledger.init(dir);
  assert.deepEqual(l2.manifest.savepoints.map((s) => s.name), ['s1']);
  assert.equal(balanceOf(l2, 'B').available, 15);

  // manifest deleted entirely: savepoint index rebuilt from the log
  fs.rmSync(path.join(dir, 'snapshot.json'));
  fs.rmSync(path.join(dir, 'snapshot.json.tmp'));
  const l3 = Ledger.init(dir);
  assert.ok(l3.savepoints.has('s1'));
  assert.equal(l3.rollback('s1').ok, true);
  assert.equal(balanceOf(l3, 'B').available, 10);
});
