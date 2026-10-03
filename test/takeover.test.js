// Acceptance 3: after member isolation (leave / quarantine) the old lease
// must expire before another AGV may take over.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';

function engineWith(...agvs) {
  const engine = new Engine();
  for (const agv of agvs) engine.applyEvent({ type: 'join', agv, ts: 0 });
  return engine;
}

test('acceptance 3: leave -> task enters takeover set, takeover only after lease expiry', () => {
  const engine = engineWith('A', 'B');
  engine.applyEvent({ type: 'claim', task: 'T1', agv: 'A', epoch: 1, ttl: 100, ts: 0, clock: { A: 1 } });
  engine.applyEvent({ type: 'leave', agv: 'A', ts: 10 });

  let summary = engine.summary();
  assert.deepEqual(summary.takeoverSet, ['T1'], 'unfinished move of the left AGV is takeoverable');
  assert.equal(summary.tasks.T1.holder, 'A', 'lease is not deleted by leave');

  const early = engine.applyEvent({ type: 'claim', task: 'T1', agv: 'B', epoch: 2, ts: 50, clock: { A: 1, B: 1 } });
  assert.equal(early.decision, 'blocked-lease', 'old lease still live at ts=50');
  assert.equal(engine.summary().tasks.T1.holder, 'A');

  const atExpiry = engine.applyEvent({ type: 'claim', task: 'T1', agv: 'B', epoch: 2, ts: 100, clock: { A: 1, B: 1 } });
  assert.equal(atExpiry.decision, 'granted', 'takeover allowed once the lease expired');
  summary = engine.summary();
  assert.equal(summary.tasks.T1.holder, 'B');
  assert.deepEqual(summary.takeoverSet, [], 'task left the takeover set after reassignment');
});

test('acceptance 3b: quarantine forbids new tasks but keeps lease history', () => {
  const engine = engineWith('A', 'B');
  engine.applyEvent({ type: 'claim', task: 'T2', agv: 'A', epoch: 1, ttl: 100, ts: 0, clock: { A: 1 } });
  engine.applyEvent({ type: 'quarantine', agv: 'A', ts: 10 });

  const denied = engine.applyEvent({ type: 'claim', task: 'T3', agv: 'A', epoch: 1, ts: 20, clock: { A: 2 } });
  assert.equal(denied.decision, 'rejected');
  assert.equal(denied.reason, 'quarantined');

  const summary = engine.summary();
  assert.deepEqual(summary.takeoverSet, [], 'quarantine does not create takeover candidates');
  assert.equal(summary.tasks.T2.leaseStatus, 'active', 'history/lease preserved');

  const early = engine.applyEvent({ type: 'claim', task: 'T2', agv: 'B', epoch: 2, ts: 99, clock: { A: 1, B: 1 } });
  assert.equal(early.decision, 'blocked-lease');
  const atExpiry = engine.applyEvent({ type: 'claim', task: 'T2', agv: 'B', epoch: 2, ts: 100, clock: { A: 1, B: 1 } });
  assert.equal(atExpiry.decision, 'granted');
});
