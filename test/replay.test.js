import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppendOnlyLog } from '../src/log.js';
import { replay } from '../src/replayer.js';

function tmpLog() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plc-log-'));
  return path.join(dir, 'events.jsonl');
}

test('acceptance 2: duplicated estop injection replays to the same state', () => {
  const file = tmpLog();
  const log = new AppendOnlyLog(file);
  log.append({ type: 'event', event: { id: 'e1', ts: 1, src: 'plc', kind: 'estop', args: {} } }, 1);
  log.append({ type: 'event', event: { id: 'e2', ts: 2, src: 'photo', kind: 'photo', args: {} } }, 2);
  // Fault injection is itself logged.
  log.append({ type: 'inject', fault: { type: 'dup', eventId: 'e1' } }, 3);

  const records = log.readAll();
  assert.ok(records.some((r) => r.type === 'inject'), 'injection must be logged');

  const withDup = replay(records, 7);
  const again = replay(records, 7);
  const withoutDup = replay(records.filter((r) => r.type !== 'inject'), 7);

  assert.equal(withDup.duplicatesCollapsed, 1, 'duplicate estop collapsed by id');
  assert.deepEqual(withDup.state, again.state, 'replay is deterministic');
  assert.deepEqual(withDup.state, withoutDup.state, 'dup injection does not change the final state');
  assert.equal(withDup.state.estop, true);
});

test('drop and delay injections are applied and logged', () => {
  const file = tmpLog();
  const log = new AppendOnlyLog(file);
  log.append({ type: 'event', event: { id: 'e1', ts: 1, src: 'plc', kind: 'estop', args: {} } }, 1);
  log.append({ type: 'event', event: { id: 'e2', ts: 2, src: 'plc', kind: 'estop_clear', args: {} } }, 2);
  log.append({ type: 'inject', fault: { type: 'drop', eventId: 'e2' } }, 3);
  log.append({ type: 'inject', fault: { type: 'delay', eventId: 'e1', delta: 10 } }, 4);

  const records = log.readAll();
  const r1 = replay(records, 0);
  const r2 = replay(records, 0);
  assert.deepEqual(r1.state, r2.state);
  assert.equal(r1.injections.length, 2);
  assert.equal(r1.events.some((e) => e.id === 'e2'), false, 'dropped event is gone');
  assert.equal(r1.events.find((e) => e.id === 'e1').ts, 11, 'delayed event shifted');
  assert.equal(r1.state.estop, true, 'estop_clear was dropped, estop survives');
});
