import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';

function engineWith(...agvs) {
  const engine = new Engine();
  for (const agv of agvs) engine.applyEvent({ type: 'join', agv, ts: 0 });
  return engine;
}

test('claim requires membership', () => {
  const engine = new Engine();
  const res = engine.applyEvent({ type: 'claim', task: 'T', agv: 'ghost', epoch: 1, ts: 0 });
  assert.equal(res.decision, 'rejected');
  assert.equal(res.reason, 'not-member');
});

test('first claim grants a lease with fencing epoch', () => {
  const engine = engineWith('A');
  const res = engine.applyEvent({ type: 'claim', task: 'T', agv: 'A', epoch: 7, ttl: 50, ts: 10 });
  assert.equal(res.decision, 'granted');
  assert.equal(res.expiry, 60);
  assert.equal(res.lease.status, 'active');
  assert.equal(res.lease.epoch, 7);
});

test('lower epoch claim is stale; equal epoch renew by holder is fine', () => {
  const engine = engineWith('A', 'B');
  engine.applyEvent({ type: 'claim', task: 'T', agv: 'A', epoch: 3, ttl: 100, ts: 0 });
  const stale = engine.applyEvent({ type: 'claim', task: 'T', agv: 'B', epoch: 2, ts: 10, clock: { A: 1, B: 1 } });
  assert.equal(stale.decision, 'stale');
  assert.equal(stale.taskEpoch, 3);
  const renew = engine.applyEvent({ type: 'claim', task: 'T', agv: 'A', epoch: 3, ttl: 100, ts: 10, clock: { A: 4 } });
  assert.equal(renew.decision, 'granted');
  assert.equal(renew.expiry, 110);
});

test('takeover is blocked while the lease is live, allowed after expiry', () => {
  const engine = engineWith('A', 'B');
  engine.applyEvent({ type: 'claim', task: 'T', agv: 'A', epoch: 1, ttl: 100, ts: 0, clock: { A: 1 } });
  const blocked = engine.applyEvent({ type: 'claim', task: 'T', agv: 'B', epoch: 2, ts: 50, clock: { A: 1, B: 1 } });
  assert.equal(blocked.decision, 'blocked-lease');
  const taken = engine.applyEvent({ type: 'claim', task: 'T', agv: 'B', epoch: 2, ts: 100, clock: { A: 1, B: 1 } });
  assert.equal(taken.decision, 'granted');
  assert.equal(engine.summary().tasks.T.holder, 'B');
});

test('quarantine blocks new claims but keeps history and leases', () => {
  const engine = engineWith('A', 'B');
  engine.applyEvent({ type: 'claim', task: 'T1', agv: 'A', epoch: 1, ttl: 100, ts: 0, clock: { A: 1 } });
  engine.applyEvent({ type: 'quarantine', agv: 'A', ts: 10 });
  const denied = engine.applyEvent({ type: 'claim', task: 'T2', agv: 'A', epoch: 1, ts: 20, clock: { A: 2 } });
  assert.equal(denied.decision, 'rejected');
  assert.equal(denied.reason, 'quarantined');
  // Existing lease still blocks others until expiry.
  const blocked = engine.applyEvent({ type: 'claim', task: 'T1', agv: 'B', epoch: 2, ts: 50, clock: { A: 1, B: 1 } });
  assert.equal(blocked.decision, 'blocked-lease');
  // Quarantined member's tasks do NOT enter the takeover set (only leave does).
  assert.deepEqual(engine.summary().takeoverSet, []);
  // History intact: lease record still active.
  assert.equal(engine.summary().tasks.T1.leaseStatus, 'active');
});

test('leave moves unfinished granted tasks to the takeover set', () => {
  const engine = engineWith('A', 'B');
  engine.applyEvent({ type: 'claim', task: 'T1', agv: 'A', epoch: 1, ttl: 100, ts: 0, clock: { A: 1 } });
  engine.applyEvent({ type: 'claim', task: 'T2', agv: 'A', epoch: 1, ttl: 100, ts: 0, clock: { A: 2 } });
  engine.applyEvent({ type: 'complete', task: 'T2', agv: 'A', epoch: 1, ts: 5 });
  engine.applyEvent({ type: 'leave', agv: 'A', ts: 10 });
  assert.deepEqual(engine.summary().takeoverSet, ['T1']);
  const claimAfterLeave = engine.applyEvent({ type: 'claim', task: 'T3', agv: 'A', epoch: 1, ts: 20 });
  assert.equal(claimAfterLeave.decision, 'rejected');
});

test('complete validates holder and fencing epoch (zombie fenced)', () => {
  const engine = engineWith('A', 'B');
  engine.applyEvent({ type: 'claim', task: 'T', agv: 'A', epoch: 2, ttl: 100, ts: 0, clock: { A: 1 } });
  const notHolder = engine.applyEvent({ type: 'complete', task: 'T', agv: 'B', epoch: 2, ts: 10 });
  assert.equal(notHolder.reason, 'not-holder');
  const zombie = engine.applyEvent({ type: 'complete', task: 'T', agv: 'A', epoch: 1, ts: 10 });
  assert.equal(zombie.decision, 'stale-complete');
  const ok = engine.applyEvent({ type: 'complete', task: 'T', agv: 'A', epoch: 2, ts: 10 });
  assert.equal(ok.decision, 'completed');
  assert.equal(engine.summary().tasks.T.status, 'completed');
});

test('superseded and duplicate claims are inert', () => {
  const engine = engineWith('A', 'B');
  engine.applyEvent({ type: 'claim', task: 'T', agv: 'A', epoch: 1, ttl: 100, ts: 0, clock: { A: 1 } });
  engine.applyEvent({ type: 'claim', task: 'T', agv: 'A', epoch: 2, ttl: 100, ts: 200, clock: { A: 2 } });
  const old = engine.applyEvent({ type: 'claim', task: 'T', agv: 'B', epoch: 2, ts: 300, clock: { A: 1 } });
  assert.equal(old.decision, 'superseded');
  const dup = engine.applyEvent({ type: 'claim', task: 'T', agv: 'A', epoch: 2, ttl: 100, ts: 300, clock: { A: 2 } });
  assert.equal(dup.decision, 'duplicate');
  assert.equal(engine.summary().tasks.T.holder, 'A');
});

test('rejoin after leave restores active membership', () => {
  const engine = engineWith('A');
  engine.applyEvent({ type: 'leave', agv: 'A', ts: 5 });
  engine.applyEvent({ type: 'join', agv: 'A', ts: 9 });
  const res = engine.applyEvent({ type: 'claim', task: 'T', agv: 'A', epoch: 1, ts: 10 });
  assert.equal(res.decision, 'granted');
});
