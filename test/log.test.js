import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventLog } from '../src/log.js';
import { Decoder } from '../src/decoder.js';
import { tmpLogPath, manualFold } from './helpers.js';

test('plain append matches manual line-by-line fold', () => {
  const file = tmpLogPath();
  const log = EventLog.open(file, { blockSize: 2 });
  log.append({ device: 'pump-1', status: 0, payload: 'start', ts: 1000 });
  log.append({ device: 'pump-1', status: 1, payload: 'run', ts: 1600 });
  log.append({ device: 'valve-2', status: 0, payload: 'open', ts: 2000 });
  log.append({ device: 'pump-1', status: 2, payload: 'hot', ts: 2500 });
  log.append({ device: 'valve-2', status: 0, payload: 'close', ts: 3100 });
  log.close();

  const expected = [
    { seq: 1, ts: 1000, device: 'pump-1', status: 0, payload: 'start', corrected: false, correctedBy: null },
    { seq: 2, ts: 1600, device: 'pump-1', status: 1, payload: 'run', corrected: false, correctedBy: null },
    { seq: 3, ts: 2000, device: 'valve-2', status: 0, payload: 'open', corrected: false, correctedBy: null },
    { seq: 4, ts: 2500, device: 'pump-1', status: 2, payload: 'hot', corrected: false, correctedBy: null },
    { seq: 5, ts: 3100, device: 'valve-2', status: 0, payload: 'close', corrected: false, correctedBy: null },
  ];
  assert.deepEqual(new Decoder(file).update().view(), expected);
  assert.deepEqual(manualFold(file), expected);
});

test('corrections and tombstones fold into view and stay in history', () => {
  const file = tmpLogPath();
  const log = EventLog.open(file, { blockSize: 3 });
  log.append({ device: 'pump-1', status: 0, payload: 'start', ts: 1000 });
  log.append({ device: 'pump-1', status: 1, payload: 'run', ts: 1600 });
  log.append({ device: 'valve-2', status: 0, payload: 'open', ts: 2000 });
  log.correct({ seq: 2, reason: 'sensor drift', status: 7, ts: 4000 });
  log.revoke({ seq: 3, reason: 'duplicate report', ts: 4100 });
  log.close();

  const decoder = new Decoder(file).update();
  assert.deepEqual(decoder.view(), [
    { seq: 1, ts: 1000, device: 'pump-1', status: 0, payload: 'start', corrected: false, correctedBy: null },
    { seq: 2, ts: 1600, device: 'pump-1', status: 7, payload: 'run', corrected: true, correctedBy: 4 },
  ]);

  const history = decoder.history();
  assert.equal(history.length, 5);
  assert.deepEqual(history.map((r) => r.type), ['event', 'event', 'event', 'correction', 'tombstone']);
  assert.equal(history[3].refSeq, 2);
  assert.equal(history[3].reason, 'sensor drift');
  assert.equal(history[4].refSeq, 3);
  assert.equal(history[4].reason, 'duplicate report');

  // Manual fold over the same file must agree with the decoder.
  assert.deepEqual(manualFold(file), decoder.view());
});

test('referencing a nonexistent event returns E_REVISION', () => {
  const file = tmpLogPath();
  const log = EventLog.open(file);
  log.append({ device: 'pump-1', status: 0, ts: 1000 });
  assert.throws(() => log.correct({ seq: 99, reason: 'nope', status: 1 }), { code: 'E_REVISION' });
  assert.throws(() => log.revoke({ seq: 99, reason: 'nope' }), { code: 'E_REVISION' });
  log.close();
});

test('correction requires a reason', () => {
  const file = tmpLogPath();
  const log = EventLog.open(file);
  log.append({ device: 'pump-1', status: 0, ts: 1000 });
  assert.throws(() => log.correct({ seq: 1, reason: '', status: 1 }), { code: 'E_FORMAT' });
  assert.throws(() => log.revoke({ seq: 1 }), { code: 'E_FORMAT' });
  log.close();
});
