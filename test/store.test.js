'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../src/store');
const fmt = require('../src/format');
const { crc32c } = require('../src/crc32c');

function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wxblk-'));
  return path.join(dir, name);
}

test('append creates file with magic and sequential ids', () => {
  const f = tmpFile('a.wx');
  const r0 = store.append(f, 'one', { timestamp: 100 });
  const r1 = store.append(f, 'two', { timestamp: 200 });
  assert.equal(r0.id, 0);
  assert.equal(r1.id, 1);
  const buf = fs.readFileSync(f);
  assert.ok(buf.subarray(0, 8).equals(fmt.MAGIC));
  assert.equal(store.verify(f).ok, true);
});

test('correct and undo basic flow', () => {
  const f = tmpFile('b.wx');
  store.append(f, 'v1', { timestamp: 1000 });
  const c = store.correct(f, 0, 'v2');
  let recs = store.decode(f).records;
  assert.equal(recs.length, 1);
  assert.equal(recs[0].payload.toString(), 'v2');
  assert.equal(recs[0].corrected, true);
  const u = store.undo(f, c.id);
  assert.equal(u.undone, true);
  recs = store.decode(f).records;
  assert.equal(recs[0].payload.toString(), 'v1');
  assert.equal(recs[0].corrected, false);
});

test('undo of already revoked correction is a no-op', () => {
  const f = tmpFile('c.wx');
  store.append(f, 'v1', { timestamp: 1 });
  const c = store.correct(f, 0, 'v2');
  store.undo(f, c.id);
  const again = store.undo(f, c.id);
  assert.equal(again.undone, false);
  assert.equal(again.alreadyRevoked, true);
});

test('ERR_RANGE on unknown / wrong-type targets', () => {
  const f = tmpFile('d.wx');
  store.append(f, 'v1', { timestamp: 1 });
  assert.throws(() => store.correct(f, 42, 'x'), (e) => e.code === 'ERR_RANGE');
  assert.throws(() => store.undo(f, 42), (e) => e.code === 'ERR_RANGE');
  assert.throws(() => store.undo(f, 0), (e) => e.code === 'ERR_RANGE'); // id 0 is DATA
});

test('ERR_CONFLICT: cannot undo a correction another correction depends on', () => {
  const f = tmpFile('e.wx');
  store.append(f, 'v1', { timestamp: 1 });
  const c1 = store.correct(f, 0, 'v2');
  const c2 = store.correct(f, c1.id, 'v3');
  assert.throws(() => store.undo(f, c1.id), (e) => e.code === 'ERR_CONFLICT');
  store.undo(f, c2.id); // now c1 has no active dependent
  const u = store.undo(f, c1.id);
  assert.equal(u.undone, true);
  assert.equal(store.decode(f).records[0].payload.toString(), 'v1');
});

test('decode time window and ERR_RANGE', () => {
  const f = tmpFile('f.wx');
  for (let i = 0; i < 5; i++) store.append(f, `obs-${i}`, { timestamp: (i + 1) * 1000 });
  const win = store.decode(f, { start: 2000, end: 4000 });
  assert.deepEqual(win.records.map((r) => r.payload.toString()), ['obs-1', 'obs-2', 'obs-3']);
  assert.throws(() => store.decode(f, { start: 5, end: 4 }), (e) => e.code === 'ERR_RANGE');
});

test('refusing to append to a damaged file', () => {
  const f = tmpFile('g.wx');
  store.append(f, 'v1', { timestamp: 1 });
  store.append(f, 'v2', { timestamp: 2 });
  const buf = fs.readFileSync(f);
  const b1 = store.scan(f).blocks[1];
  buf[b1.offset + fmt.HEADER_LEN] ^= 0xff; // corrupt payload of last block
  fs.writeFileSync(f, buf);
  assert.throws(() => store.append(f, 'v3', { timestamp: 3 }), (e) => e.code === 'ERR_CRC');
});

test('hash chain break is detected even when CRCs are fixed up', () => {
  const f = tmpFile('h.wx');
  store.append(f, 'aaaa', { timestamp: 1 });
  store.append(f, 'bbbb', { timestamp: 2 });
  store.append(f, 'cccc', { timestamp: 3 });
  const buf = fs.readFileSync(f);
  const scan = store.scan(f);
  const b1 = scan.blocks[1];
  // tamper the header (timestamp) of block 1 and repair its CRC so only the chain can catch it
  buf.writeBigInt64LE(424242n, b1.offset + 18);
  const crc = crc32c(buf.subarray(b1.offset, b1.offset + fmt.HEADER_LEN + b1.payloadLength));
  buf.writeUInt32LE(crc, b1.offset + fmt.HEADER_LEN + b1.payloadLength);
  fs.writeFileSync(f, buf);
  const report = store.verify(f);
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((e) => e.code === 'ERR_CHAIN' && e.id === 2));
  assert.throws(() => store.decode(f), (e) => e.code === 'ERR_CHAIN');
});

test('corrupted index footnote is rebuilt from block scan with diffs reported', () => {
  const f = tmpFile('i.wx');
  store.append(f, 'aaaa', { timestamp: 1 });
  store.append(f, 'bbbb', { timestamp: 2 });
  const buf = fs.readFileSync(f);
  const scan = store.scan(f);
  const b1 = scan.blocks[1];
  const footOff = b1.offset + fmt.HEADER_LEN + b1.payloadLength + fmt.CRC_LEN;
  buf[footOff + 12] ^= 0xff; // corrupt footnote offset field
  fs.writeFileSync(f, buf);
  const report = store.verify(f);
  assert.equal(report.ok, true); // index damage alone does not fail verify
  assert.equal(report.indexRebuilt, true);
  assert.ok(report.indexDiffs.some((d) => d.id === 1));
  // rebuilt index comes from the block scan and is authoritative
  assert.equal(report.index[1].offset, b1.offset);
  assert.equal(report.index[1].length, b1.length);
});

test('corrupted index field with repaired footnote CRC reports exact diff', () => {
  const f = tmpFile('j.wx');
  store.append(f, 'aaaa', { timestamp: 1 });
  store.append(f, 'bbbb', { timestamp: 2 });
  const buf = fs.readFileSync(f);
  const scan = store.scan(f);
  const b1 = scan.blocks[1];
  const footOff = b1.offset + fmt.HEADER_LEN + b1.payloadLength + fmt.CRC_LEN;
  buf.writeBigUInt64LE(999999n, footOff + 12); // wrong offset in footnote
  const footCrc = crc32c(buf.subarray(footOff, footOff + 56));
  buf.writeUInt32LE(footCrc, footOff + 56); // repair footnote CRC
  fs.writeFileSync(f, buf);
  const report = store.verify(f);
  assert.equal(report.ok, true);
  const diff = report.indexDiffs.find((d) => d.id === 1 && d.field === 'offset');
  assert.ok(diff);
  assert.equal(diff.actual, 999999);
  assert.equal(diff.expected, b1.offset);
});
