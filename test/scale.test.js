'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../lib/store');

function tmpStore() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'audit-scale-'));
}

test('20 snapshots x 5000 deltas, corrupted chunk -> restore falls back to nearest trusted point', () => {
  const dir = tmpStore();
  const accounts = {};
  for (let i = 0; i < 200; i += 1) accounts['acct-' + i] = 1000 + i;
  const reference = Object.assign({}, accounts);

  const SNAPSHOTS = 20;
  const DELTAS = 5000;
  const perRound = DELTAS / SNAPSHOTS;
  const baseSeqs = [];

  for (let round = 1; round <= SNAPSHOTS; round += 1) {
    for (let k = 0; k < perRound; k += 1) {
      const seq = (round - 1) * perRound + k + 1;
      const account = 'acct-' + (seq % 200);
      const amount = (seq * 7) % 13;
      store.appendDelta(dir, [{ type: 'add', account, amount }], { fsync: false });
      reference[account] += amount;
    }
    const manifest = store.writeSnapshot(dir, { accounts: reference }, { fsync: false, chunkSize: 1024 });
    baseSeqs.push(manifest.baseSeq);
  }
  assert.strictEqual(baseSeqs.length, SNAPSHOTS);
  assert.strictEqual(baseSeqs[SNAPSHOTS - 1], DELTAS);

  const sane = store.restore(dir);
  assert.strictEqual(sane.trustedPoint.snapshotId, 'snap-000020');
  assert.deepStrictEqual(sane.state.accounts, reference);

  const snap20 = path.join(dir, 'snapshots', 'snap-000020');
  const chunkDir = path.join(snap20, 'chunks');
  const victim = fs.readdirSync(chunkDir).sort()[1] || fs.readdirSync(chunkDir).sort()[0];
  const victimPath = path.join(chunkDir, victim);
  const original = fs.readFileSync(victimPath);
  const corrupted = Buffer.from(original);
  corrupted[0] = corrupted[0] ^ 0xff;
  fs.writeFileSync(victimPath, corrupted);

  const result = store.restore(dir);
  assert.strictEqual(result.trustedPoint.snapshotId, 'snap-000019');
  assert.strictEqual(result.trustedPoint.baseSeq, baseSeqs[SNAPSHOTS - 2]);
  assert.strictEqual(result.appliedThrough, DELTAS);
  assert.deepStrictEqual(result.state.accounts, reference);
});

test('missing chunk surfaces code=50 in check and restore falls back', () => {
  const dir = tmpStore();
  const accounts = { a: 10, b: 20 };
  store.writeSnapshot(dir, { accounts }, { fsync: false });
  store.appendDelta(dir, [{ type: 'add', account: 'a', amount: 5 }], { fsync: false });
  store.writeSnapshot(dir, { accounts: { a: 15, b: 20 } }, { fsync: false });

  const snap2 = path.join(dir, 'snapshots', 'snap-000002', 'chunks');
  fs.unlinkSync(path.join(snap2, fs.readdirSync(snap2)[0]));

  assert.throws(() => store.verifySnapshot(dir, 'snap-000002'), (err) => err.code === 50);

  const result = store.restore(dir);
  assert.strictEqual(result.trustedPoint.snapshotId, 'snap-000001');
  assert.deepStrictEqual(result.state.accounts, { a: 15, b: 20 });

  const { proof, firstError } = store.buildProof(dir);
  assert.ok(firstError, 'check must surface the missing-chunk error');
  assert.strictEqual(firstError.code, 50);
  const bad = proof.snapshots.find((s) => s.snapshotId === 'snap-000002');
  assert.strictEqual(bad.status, 'invalid');
  assert.strictEqual(bad.error.code, 50);
});

test('seq hole in delta log fails with code=51', () => {
  const dir = tmpStore();
  store.appendDelta(dir, [{ type: 'add', account: 'a', amount: 1 }], { fsync: false });
  store.appendDelta(dir, [{ type: 'add', account: 'a', amount: 2 }], { fsync: false });
  fs.appendFileSync(path.join(dir, 'delta.log'), store.canonical({ seq: 5, ops: [{ type: 'add', account: 'a', amount: 9 }] }) + '\n');

  assert.throws(() => store.restore(dir), (err) => err.code === 51);

  const { firstError } = store.buildProof(dir);
  assert.strictEqual(firstError.code, 51);
});

test('same seq different content between snapshot and delta log -> conflict', () => {
  const dir = tmpStore();
  store.appendDelta(dir, [{ type: 'add', account: 'a', amount: 3 }], { fsync: false });
  store.writeSnapshot(dir, { accounts: { a: 3 } }, { fsync: false });

  const logPath = path.join(dir, 'delta.log');
  const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
  lines[0] = store.canonical({ seq: 1, ops: [{ type: 'add', account: 'a', amount: 4 }] });
  fs.writeFileSync(logPath, lines.join('\n') + '\n');

  assert.throws(() => store.restore(dir), (err) => err.code === 52);
});

test('undo reverses add entries, including across a snapshot boundary', () => {
  const dir = tmpStore();
  store.appendDelta(dir, [{ type: 'add', account: 'a', amount: 100 }], { fsync: false });
  store.appendDelta(dir, [{ type: 'add', account: 'b', amount: 40 }], { fsync: false });
  store.writeSnapshot(dir, { accounts: { a: 100, b: 40 } }, { fsync: false });
  store.appendDelta(dir, [{ type: 'add', account: 'a', amount: 5 }], { fsync: false });
  store.appendDelta(dir, [{ type: 'undo', seq: 1 }], { fsync: false });
  store.appendDelta(dir, [{ type: 'undo', seq: 3 }], { fsync: false });

  const result = store.restore(dir);
  assert.deepStrictEqual(result.state.accounts, { a: 0, b: 40 });
});
