import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, replayEvents } from '../src/persist.js';

const OPS = [
  { op: 'set_calendar', calendar: { version: 'v1', holidays: [], skipWeekends: true } },
  { op: 'add_rule', rule: { id: 'm1', freq: 'monthly', interval: 1 } },
  { op: 'add_contract', contract: { id: 'L1', type: 'loan', start: '2024-01-31', end: '2024-06-30', ruleId: 'm1', amount: 120 } },
  { op: 'add_contract', contract: { id: 'S1', type: 'subscription', start: '2024-02-01', end: '2024-04-01', ruleId: 'm1', amount: 15 } },
  { op: 'debit_batch', date: '2024-01-31' },
  { op: 'set_calendar', calendar: { version: 'v2', holidays: ['2024-02-29'], skipWeekends: true } },
  { op: 'revoke_contract', id: 'S1' },
  { op: 'restore_contract', id: 'S1' },
];

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sched-'));
}

function taskSet(engine) {
  return JSON.stringify(engine.serialize().tasks);
}

test('reopen after clean shutdown: state equals replay', () => {
  const dir = tmpdir();
  const s1 = Store.open(dir);
  for (const op of OPS) s1.apply(op);
  const hash1 = s1.engine.stateHash();

  const s2 = Store.open(dir);
  assert.equal(s2.engine.stateHash(), hash1);
  assert.ok(s2.loadQueue(), 'queue snapshot must be valid after clean shutdown');

  const replayed = replayEvents(fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n'));
  assert.equal(taskSet(s2.engine), taskSet(replayed));
});

test('crash mid-write of batch queue: restart state equals replay result', () => {
  const dir = tmpdir();
  const s1 = Store.open(dir);
  for (const op of OPS) s1.apply(op);

  // Simulate a crash in the middle of writing the batch queue: a truncated
  // main file plus a leftover .tmp from the interrupted rename.
  const queueFile = path.join(dir, 'batches.json');
  const good = fs.readFileSync(queueFile, 'utf8');
  fs.writeFileSync(queueFile, good.slice(0, Math.floor(good.length / 2)));
  fs.writeFileSync(queueFile + '.tmp', '{"checksum":"deadbeef","data":"{}"}');

  const s2 = Store.open(dir); // must detect torn write and rebuild from log
  const replayed = replayEvents(fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n'));
  assert.equal(taskSet(s2.engine), taskSet(replayed));
  assert.equal(s2.engine.stateHash(), replayed.stateHash());
  assert.ok(s2.loadQueue(), 'queue must be rebuilt and valid after recovery');
});

test('stale queue (events appended after snapshot) is rebuilt from log', () => {
  const dir = tmpdir();
  const s1 = Store.open(dir);
  for (const op of OPS) s1.apply(op);
  // Append one more event directly, bypassing saveQueue.
  fs.appendFileSync(path.join(dir, 'events.jsonl'),
    JSON.stringify({ op: 'revoke_contract', id: 'L1' }) + '\n');
  const s2 = Store.open(dir);
  assert.equal(s2.engine.contracts.get('L1').status, 'revoked');
  const replayed = replayEvents(fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n'));
  assert.equal(taskSet(s2.engine), taskSet(replayed));
});
