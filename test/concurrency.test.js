import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Planner } from '../src/planner.js';

const snapshot = {
  machines: [{ id: 'K1', rate: 10 }],
  molds: [{ id: 'M1', machine: 'K1' }],
  operators: [{ id: 'P1' }],
  setups: [],
  orders: [{ id: 'O1', mold: 'M1', operator: 'P1', qty: 10, due: 1000 }],
};
const dupOrder = { id: 'O9', mold: 'M1', operator: 'P1', qty: 20, due: 1000 };

// Acceptance 2: two concurrent inserts of the same (same-mold) order ->
// only the causally prior one is kept, and a verifiable certificate is issued.
test('concurrent duplicate insert keeps causally prior op and emits certificate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'planner-conc-'));
  const nightShift = new Planner(dir, 'planner-night');
  nightShift.load(snapshot);
  const first = nightShift.insert(dupOrder);
  assert.equal(first.status, 'applied');
  const firstClock = nightShift.log[nightShift.log.length - 1].clock;

  // a second planner (day shift) concurrently inserts the same order id,
  // having observed nothing of the night shift's insert
  const dayShift = new Planner(dir, 'planner-day');
  const second = dayShift.insert(dupOrder, []); // empty causal context = concurrent
  assert.equal(second.status, 'rejected');
  assert.deepEqual(second.kept.clock, firstClock, 'causally prior insert is kept');

  // certificate exists and verifies
  const certs = dayShift.store.readCerts();
  assert.equal(certs.length, 1);
  assert.equal(certs[0].type, 'insert-conflict');
  assert.deepEqual(certs[0].kept.clock, firstClock);
  const v = new Planner(dir, 'auditor').verify();
  assert.ok(v.ok, JSON.stringify(v.checks));
  assert.ok(v.checks.some((c) => c.name.startsWith('cert:insert-conflict') && c.ok));

  // plan still contains exactly one O9
  const plan = new Planner(dir, 'auditor').currentPlan();
  assert.deepEqual(plan.seq.filter((id) => id === 'O9'), ['O9']);
});

test('causally-aware duplicate insert is an idempotent ack, not a conflict', () => {
  const dir = mkdtempSync(join(tmpdir(), 'planner-ack-'));
  const p1 = new Planner(dir, 'planner-night');
  p1.load(snapshot);
  p1.insert(dupOrder);
  const insertClock = p1.log[p1.log.length - 1].clock;

  const p2 = new Planner(dir, 'planner-day');
  const r = p2.insert(dupOrder, [insertClock]); // context covers the first insert
  assert.equal(r.status, 'duplicate-ack');
  assert.equal(p2.store.readCerts().length, 0, 'no conflict certificate needed');
});
