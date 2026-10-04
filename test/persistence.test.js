import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';

const OPS = [
  { op: 'add_contract', id: 'C1', type: 'loan', freq: 'monthly', start: '2024-01-31', end: '2024-06-30', amount: 100 },
  { op: 'add_contract', id: 'C2', type: 'subscription', freq: 'weekly', start: '2024-02-01', end: '2024-03-01', amount: 9 },
  { op: 'add_holiday', date: '2024-02-09' },
  { op: 'create_batch', id: 'B1', cutoff: '2024-02-29' },
  { op: 'execute_batch', id: 'B1' },
  { op: 'revoke_contract', id: 'C2' },
  { op: 'restore_contract', id: 'C2' },
  { op: 'set_calendar', holidays: ['2024-04-01'] },
];

function replayOps(ops) {
  const e = new Engine();
  for (const op of ops) e.apply(JSON.parse(JSON.stringify(op)));
  return e;
}

test('restart after torn queue write: task set equals replay result', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settle-'));
  const store = new Store(dir);
  for (const op of OPS) store.apply(op);

  // simulate crash mid-write of the batch queue: truncate queue.json
  const qf = path.join(dir, 'queue.json');
  const raw = fs.readFileSync(qf, 'utf8');
  fs.writeFileSync(qf, raw.slice(0, Math.floor(raw.length / 2)));

  const reopened = new Store(dir);
  assert.equal(reopened.recovered, true); // torn cache detected
  const expected = replayOps(OPS);
  assert.deepEqual(reopened.engine.sortedTasks(), expected.sortedTasks());
  assert.deepEqual(reopened.engine.proof(), expected.proof());
  assert.deepEqual([...reopened.engine.batches.values()], [...expected.batches.values()]);

  // and the engine keeps working correctly after recovery
  const r = reopened.apply({ op: 'add_holiday', date: '2024-05-06' });
  assert.equal(r.ok, true);
  const expected2 = replayOps([...OPS, { op: 'add_holiday', date: '2024-05-06' }]);
  assert.deepEqual(reopened.engine.proof(), expected2.proof());
});

test('clean restart: queue cache matches, no recovery flagged', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settle-'));
  const store = new Store(dir);
  for (const op of OPS) store.apply(op);
  const reopened = new Store(dir);
  assert.equal(reopened.recovered, false);
  assert.deepEqual(reopened.engine.proof(), replayOps(OPS).proof());
});
