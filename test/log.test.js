import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppendOnlyLog, LogError } from '../src/log.js';

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plc-log-'));
  return path.join(dir, 'log.jsonl');
}

test('append assigns seq, read validates and round-trips', () => {
  const file = tmpFile();
  const log = new AppendOnlyLog(file);
  log.append({ type: 'event', event: { id: 'e1', ts: 1, src: 'plc', kind: 'estop', args: {} } }, 10);
  log.append({ type: 'inject', fault: { type: 'dup', eventId: 'e1' } }, 20);
  const records = log.readAll();
  assert.deepEqual(records.map((r) => r.seq), [0, 1]);
  assert.deepEqual(records.map((r) => r.ts), [10, 20]);

  // Reopening continues the sequence.
  const log2 = new AppendOnlyLog(file);
  const rec = log2.append({ type: 'event', event: { id: 'e2', ts: 3, src: 'cyl', kind: 'cyl_done', args: {} } }, 30);
  assert.equal(rec.seq, 2);
});

test('seq hole reports ERR_GAP', () => {
  const file = tmpFile();
  fs.writeFileSync(
    file,
    JSON.stringify({ seq: 0, ts: 1, type: 'event', event: { id: 'e1', ts: 1, src: 'plc', kind: 'estop' } }) +
      '\n' +
      JSON.stringify({ seq: 2, ts: 2, type: 'event', event: { id: 'e2', ts: 2, src: 'plc', kind: 'photo' } }) +
      '\n',
  );
  assert.throws(() => AppendOnlyLog.readAll(file), (err) => err instanceof LogError && err.code === 'ERR_GAP');
});

test('clock inversion reports ERR_CLOCK', () => {
  const file = tmpFile();
  fs.writeFileSync(
    file,
    JSON.stringify({ seq: 0, ts: 10, type: 'event', event: { id: 'e1', ts: 1, src: 'plc', kind: 'estop' } }) +
      '\n' +
      JSON.stringify({ seq: 1, ts: 9, type: 'event', event: { id: 'e2', ts: 2, src: 'plc', kind: 'photo' } }) +
      '\n',
  );
  assert.throws(() => AppendOnlyLog.readAll(file), (err) => err instanceof LogError && err.code === 'ERR_CLOCK');
});

test('append rejects a backwards ts with ERR_CLOCK', () => {
  const file = tmpFile();
  const log = new AppendOnlyLog(file);
  log.append({ type: 'event', event: { id: 'e1', ts: 1, src: 'plc', kind: 'estop', args: {} } }, 10);
  assert.throws(
    () => log.append({ type: 'event', event: { id: 'e2', ts: 2, src: 'plc', kind: 'photo', args: {} } }, 5),
    (err) => err.code === 'ERR_CLOCK',
  );
});
