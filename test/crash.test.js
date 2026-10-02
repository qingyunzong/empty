import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, appendFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Planner } from '../src/planner.js';
import { canonical } from '../src/model.js';

const snapshot = {
  machines: [{ id: 'K1', rate: 10 }],
  molds: [{ id: 'M1', machine: 'K1' }],
  operators: [{ id: 'P1' }],
  setups: [],
  orders: [{ id: 'O1', mold: 'M1', operator: 'P1', qty: 10, due: 1000 }],
};

// Acceptance 4: a crash after writing plan.tmp must not leave a half commit.
test('crash after plan.tmp write: restart discards it, no half commit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'planner-crash-'));
  const p = new Planner(dir, 'planner-0');
  const committed = p.load(snapshot);
  const committedLog = readFileSync(join(dir, 'log.jsonl'), 'utf8');

  // simulate a crash mid-commit: half-written plan.tmp + an appended but
  // never-committed op in the log (the commit order is append -> tmp -> rename)
  writeFileSync(join(dir, 'plan.tmp'), canonical(committed).slice(0, 40)); // torn write
  const ghost = { ...JSON.parse(committedLog.trim().split('\n').pop()) };
  ghost.seq = 2; ghost.kind = 'insert';
  ghost.payload = { order: { id: 'GHOST', mold: 'M1', operator: 'P1', qty: 5, due: 1000 } };
  appendFileSync(join(dir, 'log.jsonl'), canonical(ghost) + '\n');

  // restart: tmp discarded, uncommitted op truncated, last committed plan intact
  const q = new Planner(dir, 'planner-0');
  assert.ok(!existsSync(join(dir, 'plan.tmp')), 'plan.tmp must be discarded');
  assert.equal(q.log.length, 1, 'uncommitted op must be truncated');
  assert.equal(q.currentPlan().digest, committed.digest);
  assert.ok(q.verify().ok);

  // and the planner keeps working on the recovered state
  const r = q.insert({ id: 'O2', mold: 'M1', operator: 'P1', qty: 5, due: 1000 });
  assert.equal(r.status, 'applied');
  assert.deepEqual(q.currentPlan().seq, ['O1', 'O2']);
});

test('undo history survives restart (undone ops are not mistaken for crash residue)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'planner-crash2-'));
  const p = new Planner(dir, 'planner-0');
  p.load(snapshot);
  p.insert({ id: 'O2', mold: 'M1', operator: 'P1', qty: 5, due: 1000 });
  const full = p.currentPlan().digest;
  p.undoTo(1);

  // restart at the undone point, then restore forward
  const q = new Planner(dir, 'planner-0');
  assert.equal(q.log.length, 2, 'undone op retained for restore');
  assert.equal(q.head, 1);
  q.undoTo(2);
  assert.equal(q.currentPlan().digest, full);
});
