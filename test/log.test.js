import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { appendRecord, scanLog, truncateLog } from '../src/log.js';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-log-'));
}

test('append and scan roundtrip with offsets', () => {
  const dir = tmp();
  const p = path.join(dir, 'events.log');
  const a = appendRecord(p, { seq: 0, event: { type: 'receive' }, result: { ok: true } });
  const b = appendRecord(p, { seq: 1, event: { type: 'issue' }, result: { ok: true } });
  assert.equal(a.offset, 0);
  assert.equal(b.offset, a.bytes);
  const { records, corruptOffset } = scanLog(p);
  assert.equal(corruptOffset, null);
  assert.equal(records.length, 2);
  assert.equal(records[1].record.event.type, 'issue');
  assert.equal(records[1].offset, b.offset);
});

test('crc corruption is reported at block offset', () => {
  const dir = tmp();
  const p = path.join(dir, 'events.log');
  appendRecord(p, { n: 1 });
  const second = appendRecord(p, { n: 2 });
  const buf = fs.readFileSync(p);
  buf[second.offset + 6] ^= 0xff; // flip a payload byte in block 2
  fs.writeFileSync(p, buf);
  const { records, corruptOffset, reason } = scanLog(p);
  assert.equal(records.length, 1);
  assert.equal(corruptOffset, second.offset);
  assert.equal(reason, 'crc-mismatch');
});

test('torn tail is reported and truncatable', () => {
  const dir = tmp();
  const p = path.join(dir, 'events.log');
  appendRecord(p, { n: 1 });
  const second = appendRecord(p, { n: 2 });
  fs.truncateSync(p, second.offset + 8); // partial block: header ok, payload cut
  const { records, corruptOffset, reason } = scanLog(p);
  assert.equal(records.length, 1);
  assert.equal(corruptOffset, second.offset);
  assert.equal(reason, 'truncated-payload');
  truncateLog(p, corruptOffset);
  const again = scanLog(p);
  assert.equal(again.corruptOffset, null);
  assert.equal(again.records.length, 1);
});
