import test from 'node:test';
import assert from 'node:assert/strict';
import { branch, ev } from './helpers.js';
import { mergeBranches } from '../src/merge.js';
import { checkMergeReport, checkCertificate } from '../src/checker.js';

test('different-field changes combine; same-scalar divergent edits conflict', () => {
  const base = branch([ev('A', 1, { note: 'x' })]);
  const local = branch([ev('A', 1, { note: 'y' })]);
  const remote = branch([ev('A', 1, { note: 'x', ackBy: 'op-1' })]);
  const r = mergeBranches(base, local, remote);
  assert.equal(r.conflicts.length, 0);
  assert.equal(r.events.get('A').note, 'y');
  assert.equal(r.events.get('A').ackBy, 'op-1');

  const local2 = branch([ev('A', 1, { note: 'a' })]);
  const remote2 = branch([ev('A', 1, { note: 'b' })]);
  const r2 = mergeBranches(base, local2, remote2);
  assert.equal(r2.conflicts.length, 1);
  const c = r2.conflicts[0];
  assert.equal(c.type, 'FIELD');
  assert.equal(c.field, 'note');
  assert.equal(c.local, 'a');
  assert.equal(c.remote, 'b');
  assert.equal(r2.events.get('A').note, 'x'); // tentative base value
  assert.equal(checkMergeReport(base, local2, remote2, r2).ok, true);
});

test('cross-branch edge additions form a verifiable cycle with branch provenance', () => {
  const base = branch([ev('A', 1), ev('B', 2)]);
  const local = branch([ev('A', 1), ev('B', 2, { dependsOn: ['A'] })]);
  const remote = branch([ev('A', 1, { dependsOn: ['B'] }), ev('B', 2)]);
  const r = mergeBranches(base, local, remote);
  assert.ok(r.cycle, 'cycle must be reported, not masked by ts ordering');
  assert.equal(r.cycle.nodes[0], r.cycle.nodes[r.cycle.nodes.length - 1]);
  const edgeAB = r.cycle.edges.find((e) => e.event === 'B' && e.dependsOn === 'A');
  const edgeBA = r.cycle.edges.find((e) => e.event === 'A' && e.dependsOn === 'B');
  assert.deepEqual(edgeAB.branches, ['local']);
  assert.deepEqual(edgeBA.branches, ['remote']);
  assert.equal(r.certificate, null);
  assert.equal(checkMergeReport(base, local, remote, r).ok, true);
});

test('DELETE_UPDATE: delete vs field/dependency edit conflicts; double delete merges', () => {
  const base = branch([ev('D', 1, { note: 'x' }), ev('F', 2, { dependsOn: ['D'] })]);
  const local = branch([ev('D', 1, { note: 'x', deleted: true }), ev('F', 2, { dependsOn: ['D'] })]);
  const remote = branch([ev('D', 1, { note: 'y' }), ev('F', 2, { dependsOn: ['D'] })]);
  const r = mergeBranches(base, local, remote);
  assert.equal(r.conflicts.length, 1);
  const c = r.conflicts[0];
  assert.equal(c.type, 'DELETE_UPDATE');
  assert.equal(c.eventId, 'D');
  assert.equal(c.deleteSide, 'local');
  assert.ok(c.coveredFields.includes('deleted'));
  assert.ok(c.coveredFields.includes('note'));
  // Tentative merge keeps the withdrawal; dependency edge is not removed.
  assert.equal(r.events.get('D').deleted, true);
  assert.deepEqual(r.events.get('F').dependsOn, ['D']);
  assert.equal(checkMergeReport(base, local, remote, r).ok, true);

  const remoteBoth = branch([ev('D', 1, { note: 'y', deleted: true }), ev('F', 2, { dependsOn: ['D'] })]);
  const r2 = mergeBranches(base, local, remoteBoth);
  assert.equal(r2.conflicts.length, 0);
  assert.equal(r2.events.get('D').deleted, true);
  assert.equal(r2.events.get('D').note, 'y');
});

test('BLOCKED: non-deleted event depending on deleted event is reported, edge kept', () => {
  const base = branch([ev('D', 1), ev('F', 2, { dependsOn: ['D'] })]);
  const local = branch([ev('D', 1, { deleted: true }), ev('F', 2, { dependsOn: ['D'] })]);
  const remote = branch([ev('D', 1), ev('F', 2, { dependsOn: ['D'] })]);
  const r = mergeBranches(base, local, remote);
  assert.equal(r.conflicts.length, 0);
  assert.equal(r.events.get('D').deleted, true);
  assert.deepEqual(r.events.get('F').dependsOn, ['D']);
  assert.deepEqual(r.blocked, [{ id: 'F', blockedBy: ['D'] }]);
  // Topo certificate still covers all events including deleted ones.
  assert.deepEqual(r.certificate.order, ['D', 'F']);
  assert.equal(checkCertificate(r.events, r.certificate).ok, true);
});

test('per-edge dependsOn merge: add/add, remove vs keep, add vs absent', () => {
  const base = branch([ev('A', 1), ev('B', 2), ev('C', 3, { dependsOn: ['A'] })]);
  const local = branch([ev('A', 1), ev('B', 2), ev('C', 3, { dependsOn: ['A', 'B'] })]);
  const remote = branch([ev('A', 1), ev('B', 2), ev('C', 3)]);
  const r = mergeBranches(base, local, remote);
  assert.equal(r.conflicts.length, 0);
  // local added B (kept), remote removed A (removed: local did not touch A... it kept it).
  assert.deepEqual(r.events.get('C').dependsOn, ['B']);
});

test('resolutions applied through full merge clear conflicts', () => {
  const base = branch([ev('A', 1, { note: 'x' })]);
  const local = branch([ev('A', 1, { note: 'a' })]);
  const remote = branch([ev('A', 1, { note: 'b' })]);
  const r0 = mergeBranches(base, local, remote);
  const cid = r0.conflicts[0].conflictId;
  const r1 = mergeBranches(base, local, remote, [{ conflictId: cid, pick: 'remote' }]);
  assert.equal(r1.events.get('A').note, 'b');
  assert.deepEqual(r1.appliedResolutions, [cid]);
});
