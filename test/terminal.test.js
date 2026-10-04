'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Terminal } = require('../lib/terminal');
const { chainFrames, hashes, nextOpId } = require('./helpers');

test('acceptance 1: replaying the same opId is deduplicated', () => {
  const term = new Terminal(null);
  const [frame] = chainFrames([{ args: { key: 'k', value: 42 } }]);
  const first = term.submit(frame);
  assert.equal(first[0].status, 'applied');
  const second = term.submit(frame);
  assert.equal(second[0].status, 'duplicate');
  assert.equal(second[0].hash, first[0].hash);
  assert.equal(term.log.entries.length, 1);
});

test('acceptance 2: out-of-order prevHash is buffered, then committed in chain order', () => {
  const frames = chainFrames([
    { args: { key: 'a', value: 1 } },
    { args: { key: 'b', value: 2 } },
    { args: { key: 'c', value: 3 } },
    { args: { key: 'd', value: 4 } },
  ]);
  const term = new Terminal(null);
  assert.equal(term.submit(frames[2])[0].status, 'buffered');
  assert.equal(term.submit(frames[0])[0].status, 'applied');
  assert.equal(term.submit(frames[3])[0].status, 'buffered');
  const events = term.submit(frames[1]);
  assert.deepEqual(events.map((e) => e.status), ['applied', 'applied', 'applied']);
  assert.deepEqual(events.map((e) => e.opId), [frames[1].opId, frames[2].opId, frames[3].opId]);
  assert.equal(term.log.entries.length, 4);
  // The committed chain equals the reference serial order.
  const ref = new Terminal(null);
  for (const f of frames) ref.submit(f);
  assert.deepEqual(hashes(term), hashes(ref));
});

test('acceptance 3: undo, then undo of the undo, appends inverse entries (no truncation)', () => {
  const term = new Terminal(null);
  const [set] = chainFrames([{ args: { key: 'k', value: 1 } }]);
  term.submit(set);
  const mkUndo = (targetOpId) => ({
    opId: nextOpId(), actor: 'A', seq: term.expectedSeq.get('A') || 1, ack: 0,
    leaseUntil: 1e9, cmd: 'undo', args: { opId: targetOpId }, prevHash: term.log.headHash,
  });
  const u1 = mkUndo(set.opId);
  term.submit(u1);
  assert.equal(term.state.get('k'), undefined);
  const u2 = mkUndo(u1.opId);
  term.submit(u2);
  assert.equal(term.state.get('k'), 1);
  assert.equal(term.log.entries.length, 3);
  const [e1, e2, e3] = term.log.entries;
  assert.equal(e2.kind, 'inverse');
  assert.equal(e2.newValue, null);
  assert.equal(e2.proof.targetHash, e1.hash);
  assert.equal(e2.proof.targetStateBefore, e1.stateHashBefore);
  assert.equal(e3.kind, 'inverse');
  assert.equal(e3.newValue, 1);
  assert.equal(e3.proof.targetHash, e2.hash);
  assert.equal(e3.prevHash, e2.hash);
});

test('undo of an unknown target is rejected with a reason', () => {
  const term = new Terminal(null);
  const frame = {
    opId: nextOpId(), actor: 'A', seq: 1, ack: 0, leaseUntil: 1e9,
    cmd: 'undo', args: { opId: 'f'.repeat(32) }, prevHash: term.log.headHash,
  };
  const events = term.submit(frame);
  assert.equal(events[0].status, 'rejected');
  assert.equal(events[0].reason, 'undo_target_unknown');
});

test('expired lease is rejected but evidence is preserved; seq is consumed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'at-lease-'));
  const term = new Terminal(dir);
  const frames = chainFrames([
    { args: { key: 'a', value: 1 } },
    { args: { key: 'b', value: 2 } },
    { args: { key: 'c', value: 3 }, leaseUntil: 1 }, // expires: commit clock would be 2
    { args: { key: 'd', value: 4 }, seq: 4 },
  ]);
  term.submit(frames[0]);
  term.submit(frames[1]);
  const rejected = term.submit(frames[2]);
  assert.equal(rejected[0].status, 'rejected');
  assert.equal(rejected[0].reason, 'lease_expired');
  assert.equal(term.leaseExpired, 1);
  const applied = term.submit(frames[3]);
  assert.equal(applied[0].status, 'applied'); // seq 4 still accepted after seq 3 was consumed
  // Retransmitting the rejected frame replays the rejection.
  const again = term.submit(frames[2]);
  assert.equal(again[0].status, 'rejected');
  assert.equal(again[0].duplicate, true);
  // Evidence log holds the rejected late write.
  const evidence = fs.readFileSync(path.join(dir, 'evidence.log'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].reason, 'lease_expired');
  assert.equal(evidence[0].opId, frames[2].opId);
  assert.match(evidence[0].frameHash, /^[0-9a-f]{64}$/);
});

test('stale seq from the same actor is rejected', () => {
  const term = new Terminal(null);
  const frames = chainFrames([{ args: { key: 'a', value: 1 } }, { args: { key: 'b', value: 2 } }]);
  term.submit(frames[0]);
  term.submit(frames[1]);
  const stale = { ...frames[1], opId: nextOpId(), prevHash: term.log.headHash };
  const events = term.submit(stale);
  assert.equal(events[0].status, 'rejected');
  assert.equal(events[0].reason, 'stale_seq');
});

test('seq gap is buffered until the missing seq arrives', () => {
  const term = new Terminal(null);
  const frames = chainFrames([{ args: { key: 'a', value: 1 } }, { args: { key: 'b', value: 2 } }]);
  assert.equal(term.submit(frames[1])[0].status, 'buffered');
  const events = term.submit(frames[0]);
  assert.deepEqual(events.map((e) => e.status), ['applied', 'applied']);
  assert.equal(term.log.entries.length, 2);
});
