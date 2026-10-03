import test from 'node:test';
import assert from 'node:assert/strict';
import { ev } from './helpers.js';
import { validateBranch } from '../src/events.js';
import { mergeBranches, mergeEdges } from '../src/merge.js';
import { computeDerived } from '../src/derive.js';

const byId = (arr) => Object.fromEntries(arr.map((e) => [e.id, e]));

test('branch validation rejects missing references', () => {
  assert.throws(() => validateBranch([ev('a', 1, { dependsOn: ['ghost'] })]), /missing event ghost/);
});

test('branch validation rejects cyclic dependency graphs', () => {
  const events = [ev('a', 1, { dependsOn: ['b'] }), ev('b', 2, { dependsOn: ['a'] })];
  assert.throws(() => validateBranch(events), /cycle/);
});

test('changes to different fields combine cleanly', () => {
  const base = byId([ev('a', 1, { note: 'x' })]);
  const local = byId([ev('a', 1, { note: 'y' })]);
  const remote = byId([ev('a', 5, { note: 'x' })]);
  const { events, conflicts } = mergeBranches(base, local, remote);
  assert.equal(conflicts.size, 0);
  assert.equal(events.a.note, 'y');
  assert.equal(events.a.ts, 5);
});

test('same scalar changed differently on both sides conflicts', () => {
  const base = byId([ev('a', 1, { note: 'x' })]);
  const local = byId([ev('a', 1, { note: 'y' })]);
  const remote = byId([ev('a', 1, { note: 'z' })]);
  const { conflicts } = mergeBranches(base, local, remote);
  const c = conflicts.get('field:a:note');
  assert.equal(c.type, 'FIELD');
  assert.deepEqual(c.fields.note, { base: 'x', local: 'y', remote: 'z' });
});

test('dependsOn merges per edge via three-way presence', () => {
  // removal by one side wins over unchanged other side
  assert.deepEqual(mergeEdges(['b'], [], ['b']), []);
  // additions from either side are kept
  assert.deepEqual(mergeEdges([], ['c'], ['d']), ['c', 'd']);
  // kept when present everywhere
  assert.deepEqual(mergeEdges(['b'], ['b'], ['b']), ['b']);
  // removed only when both sides removed it
  assert.deepEqual(mergeEdges(['b'], [], []), []);
});

test('DELETE_UPDATE: retract on one side vs field/dependency update on the other', () => {
  const base = byId([ev('a', 1, { note: 'x' }), ev('b', 0)]);
  const local = byId([ev('a', 1, { note: 'x', deleted: true }), ev('b', 0)]);
  const remote = byId([ev('a', 1, { note: 'y', dependsOn: ['b'] }), ev('b', 0)]);
  const { events, conflicts } = mergeBranches(base, local, remote);
  const c = conflicts.get('delete-update:a');
  assert.equal(c.type, 'DELETE_UPDATE');
  assert.equal(c.deletingSide, 'local');
  assert.deepEqual(Object.keys(c.fields).sort(), ['deleted', 'dependsOn', 'note']);
  // tentative merge keeps the retraction and the other side's edits
  assert.equal(events.a.deleted, true);
  assert.equal(events.a.note, 'y');
});

test('retraction on both sides merges without conflict', () => {
  const base = byId([ev('a', 1)]);
  const local = byId([ev('a', 1, { deleted: true })]);
  const remote = byId([ev('a', 1, { deleted: true })]);
  const { events, conflicts } = mergeBranches(base, local, remote);
  assert.equal(conflicts.size, 0);
  assert.equal(events.a.deleted, true);
});

test('retraction vs untouched other side merges as retracted', () => {
  const base = byId([ev('a', 1, { note: 'x' })]);
  const local = byId([ev('a', 1, { deleted: true, note: 'x' })]);
  const remote = byId([ev('a', 1, { note: 'x' })]);
  const { events, conflicts } = mergeBranches(base, local, remote);
  assert.equal(conflicts.size, 0);
  assert.equal(events.a.deleted, true);
});

test('cross-branch edge additions can form a verifiable cycle', () => {
  const base = byId([ev('a', 1), ev('b', 2)]);
  const local = byId([ev('a', 1, { dependsOn: ['b'] }), ev('b', 2)]);
  const remote = byId([ev('a', 1), ev('b', 2, { dependsOn: ['a'] })]);
  const { events, conflicts } = mergeBranches(base, local, remote);
  assert.equal(conflicts.size, 0);
  const branches = { base, local, remote };
  const derived = computeDerived(events, branches);
  assert.ok(derived.cycle, 'cycle must be reported');
  // The reported cycle is verifiable: consecutive edges exist in the merged graph.
  const cyc = derived.cycle.events;
  for (let i = 0; i < cyc.length - 1; i += 1) {
    assert.ok(events[cyc[i + 1]].dependsOn.includes(cyc[i]), `edge ${cyc[i]}->${cyc[i + 1]} exists`);
  }
  assert.equal(cyc[0], cyc[cyc.length - 1], 'cycle closes');
  // Edge provenance names the contributing branches.
  const prov = Object.fromEntries(derived.cycle.edges.map((e) => [`${e.from}->${e.to}`, e.addedBy]));
  assert.deepEqual(prov['b->a'], ['local']);
  assert.deepEqual(prov['a->b'], ['remote']);
  // No topological order is produced for a cyclic graph.
  assert.equal(derived.order, null);
});

test('deleted events keep metadata and edges; dependents become BLOCKED', () => {
  const base = byId([ev('x', 1), ev('y', 2, { dependsOn: ['x'] })]);
  const local = byId([ev('x', 1, { deleted: true }), ev('y', 2, { dependsOn: ['x'] })]);
  const remote = byId([ev('x', 1), ev('y', 2, { dependsOn: ['x'] })]);
  const { events } = mergeBranches(base, local, remote);
  assert.equal(events.x.deleted, true);
  assert.deepEqual(events.y.dependsOn, ['x'], 'dependency is never silently removed');
  const derived = computeDerived(events, { base, local, remote });
  assert.deepEqual(derived.blocked, [{ event: 'y', blockedBy: ['x'] }]);
});
