'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Journal, recoverJournal, atomicWriteFile, encodeFrame } = require('../src/journal.js');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cal-journal-'));
}

test('append + recover round-trips complete records', () => {
  const dir = tmpdir();
  const jp = path.join(dir, 'm.journal');
  const j = new Journal(jp);
  j.append({ type: 'measure', record: { id: 'M-1' } });
  j.append({ type: 'measure', record: { id: 'M-2' } });
  const rec = recoverJournal(jp);
  assert.equal(rec.recovered, false);
  assert.deepEqual(rec.records.map((r) => r.record.id), ['M-1', 'M-2']);
});

test('crash mid-append: torn tail is truncated, no half measure survives', () => {
  const dir = tmpdir();
  const jp = path.join(dir, 'm.journal');
  const j = new Journal(jp);
  j.append({ type: 'measure', record: { id: 'M-1' } });
  // simulate a crash between append and fsync: half a frame hits the file
  const frame = encodeFrame({ type: 'measure', record: { id: 'M-2' } });
  fs.appendFileSync(jp, frame.subarray(0, Math.floor(frame.length / 2)));
  const rec = recoverJournal(jp);
  assert.equal(rec.recovered, true);
  assert.ok(rec.truncatedBytes > 0);
  assert.deepEqual(rec.records.map((r) => r.record.id), ['M-1']);
  // journal stays usable after recovery
  j.append({ type: 'measure', record: { id: 'M-3' } });
  const rec2 = recoverJournal(jp);
  assert.equal(rec2.recovered, false);
  assert.deepEqual(rec2.records.map((r) => r.record.id), ['M-1', 'M-3']);
});

test('corrupt frame (bad crc) stops the scan and is removed', () => {
  const dir = tmpdir();
  const jp = path.join(dir, 'm.journal');
  const j = new Journal(jp);
  j.append({ type: 'measure', record: { id: 'M-1' } });
  j.append({ type: 'measure', record: { id: 'M-2' } });
  const buf = fs.readFileSync(jp);
  buf[buf.length - 6] ^= 0xff; // flip a payload/crc byte of the last frame
  fs.writeFileSync(jp, buf);
  const rec = recoverJournal(jp);
  assert.equal(rec.recovered, true);
  assert.deepEqual(rec.records.map((r) => r.record.id), ['M-1']);
});

test('garbage shorter than a frame header is also cleaned up', () => {
  const dir = tmpdir();
  const jp = path.join(dir, 'm.journal');
  new Journal(jp).append({ type: 'measure', record: { id: 'M-1' } });
  fs.appendFileSync(jp, Buffer.from([0x4d, 0x4a, 0x05]));
  const rec = recoverJournal(jp);
  assert.equal(rec.recovered, true);
  assert.equal(rec.records.length, 1);
});

test('atomicWriteFile: crash before rename keeps the old file; rename replaces', () => {
  const dir = tmpdir();
  const sp = path.join(dir, 'state.json');
  atomicWriteFile(sp, JSON.stringify({ v: 1 }));
  // simulate a crash after writing the tmp file but before rename
  fs.writeFileSync(`${sp}.tmp-999`, '{"v":2,"partial"');
  assert.equal(JSON.parse(fs.readFileSync(sp, 'utf8')).v, 1);
  atomicWriteFile(sp, JSON.stringify({ v: 2 }));
  assert.equal(JSON.parse(fs.readFileSync(sp, 'utf8')).v, 2);
  // leftover tmp files never affect the real state file
  assert.ok(fs.existsSync(`${sp}.tmp-999`));
});
