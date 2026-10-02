import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventLog } from '../src/log.js';
import { Decoder } from '../src/decoder.js';
import { tmpLogPath, scanBlocks } from './helpers.js';

function seedLog(file) {
  const log = EventLog.open(file, { blockSize: 2 });
  log.append({ device: 'pump-1', status: 0, payload: 'e1', ts: 1000 });
  log.append({ device: 'pump-1', status: 1, payload: 'e2', ts: 1600 });
  log.append({ device: 'valve-2', status: 0, payload: 'e3', ts: 2000 });
  log.append({ device: 'valve-2', status: 1, payload: 'e4', ts: 2500 });
  log.append({ device: 'pump-1', status: 2, payload: 'e5', ts: 3100 });
  log.append({ device: 'pump-1', status: 3, payload: 'e6', ts: 3600 });
  log.close();
}

test('corrupt block returns E_CRC and leaves no half-updated state', () => {
  const file = tmpLogPath();
  seedLog(file); // 3 blocks of 2 events each

  const blocks = scanBlocks(file);
  assert.equal(blocks.length, 3);
  const victim = blocks[1];

  // Flip one byte inside the second block's payload (past the 8-byte header).
  const fd = fs.openSync(file, 'r+');
  const pos = victim.offset + 9;
  const original = Buffer.alloc(1);
  fs.readSync(fd, original, 0, 1, pos);
  fs.writeSync(fd, Buffer.from([original[0] ^ 0xff]), 0, 1, pos);
  fs.closeSync(fd);

  const decoder = new Decoder(file);
  assert.throws(() => decoder.update(), { code: 'E_CRC' });

  // State contains exactly the events of the intact first block: nothing
  // from the corrupt block leaked in, and nothing was applied partially.
  assert.deepEqual(
    decoder.view().map((r) => r.seq),
    [1, 2],
  );
  assert.deepEqual(
    decoder.history().map((r) => r.seq),
    [1, 2],
  );

  // Opening the log for append also refuses to silently skip the bad block
  // when the index is gone, surfacing E_CRC instead of truncating data.
  fs.truncateSync(file, blocks[2].offset + blocks[2].size); // drop tail index
  assert.throws(() => EventLog.open(file), { code: 'E_CRC' });
});

test('corrupt tail index triggers full scan rebuild with identical results', () => {
  const file = tmpLogPath();
  seedLog(file);
  const baselineView = new Decoder(file).update().view();
  const baselineHistory = new Decoder(file).update().history();

  const blocks = scanBlocks(file);
  const dataEnd = blocks[2].offset + blocks[2].size;

  // Corrupt the index payload (CRC no longer matches).
  const fd = fs.openSync(file, 'r+');
  const original = Buffer.alloc(1);
  fs.readSync(fd, original, 0, 1, dataEnd);
  fs.writeSync(fd, Buffer.from([original[0] ^ 0xff]), 0, 1, dataEnd);
  fs.closeSync(fd);

  // Decoder ignores the index entirely and still agrees.
  assert.deepEqual(new Decoder(file).update().view(), baselineView);

  // Reopen: index is rebuilt by full scan, append continues to work.
  const log = EventLog.open(file, { blockSize: 2 });
  assert.equal(log.nextSeq, 7);
  log.append({ device: 'pump-1', status: 4, payload: 'e7', ts: 4000 });
  log.close();

  const view = new Decoder(file).update().view();
  assert.deepEqual(view.slice(0, 6), baselineView);
  assert.equal(view.length, 7);
  assert.equal(view[6].payload, 'e7');
  assert.deepEqual(new Decoder(file).update().history().slice(0, 6), baselineHistory);
});

test('missing tail index is rebuilt by scan after restart', () => {
  const file = tmpLogPath();
  seedLog(file);
  const baselineView = new Decoder(file).update().view();

  const blocks = scanBlocks(file);
  const dataEnd = blocks[2].offset + blocks[2].size;
  fs.truncateSync(file, dataEnd); // index gone entirely

  const log = EventLog.open(file, { blockSize: 2 });
  assert.equal(log.nextSeq, 7);
  log.close();

  assert.deepEqual(new Decoder(file).update().view(), baselineView);
});

test('restart with intact index yields identical view and history', () => {
  const file = tmpLogPath();
  const log = EventLog.open(file, { blockSize: 2 });
  log.append({ device: 'pump-1', status: 0, payload: 'e1', ts: 1000 });
  log.append({ device: 'pump-1', status: 1, payload: 'e2', ts: 1600 });
  log.correct({ seq: 1, reason: 'fix', status: 8, ts: 2000 });
  log.revoke({ seq: 2, reason: 'dup', ts: 2100 });
  log.close();

  const first = new Decoder(file).update();
  const view1 = first.view();
  const history1 = first.history();

  // Simulate restart: brand new decoder instances over the same file.
  const second = new Decoder(file).update();
  assert.deepEqual(second.view(), view1);
  assert.deepEqual(second.history(), history1);

  // And after an open/close cycle that rewrites the tail index.
  const log2 = EventLog.open(file, { blockSize: 2 });
  log2.close();
  const third = new Decoder(file).update();
  assert.deepEqual(third.view(), view1);
  assert.deepEqual(third.history(), history1);
});
