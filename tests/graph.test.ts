import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VersionGraph } from '../src/graph.js';
import type { ConfigData, Migration } from '../src/types.js';

function step(id: string, from: string, to: string): Migration {
  function up(c: ConfigData): ConfigData { return c; }
  function down(c: ConfigData): ConfigData { return c; }
  return { id, from, to, up, down };
}

function ids(path: Migration[] | null): string[] {
  if (path === null) return [];
  return path.map((m) => m.id);
}

test('prefers the path with fewest steps on a branching graph', () => {
  const g = new VersionGraph();
  g.add(step('m100', '1.0', '2.0'));
  g.add(step('m001', '1.0', '1.1'));
  g.add(step('m002', '1.1', '1.5'));
  g.add(step('m003', '1.5', '2.0'));
  assert.deepEqual(ids(g.findPath('1.0', '2.0')), ['m100']);
});

test('fewer steps wins even against lexicographically smaller ids', () => {
  const g = new VersionGraph();
  g.add(step('m900', '1.0', '2.0'));
  g.add(step('m001', '1.0', '1.1'));
  g.add(step('m002', '1.1', '2.0'));
  assert.deepEqual(ids(g.findPath('1.0', '2.0')), ['m900']);
});

test('breaks step-count ties by migration id sequence', () => {
  const g = new VersionGraph();
  g.add(step('m011', '1.0', '1.3'));
  g.add(step('m009', '1.3', '2.0'));
  g.add(step('m010', '1.0', '1.2'));
  g.add(step('m020', '1.2', '2.0'));
  assert.deepEqual(ids(g.findPath('1.0', '2.0')), ['m010', 'm020']);
});

test('tie-break compares the whole id sequence, not just the first id', () => {
  const g = new VersionGraph();
  g.add(step('m001', '1.0', '1.2'));
  g.add(step('m099', '1.2', '2.0'));
  g.add(step('m002', '1.0', '1.3'));
  g.add(step('m003', '1.3', '2.0'));
  assert.deepEqual(ids(g.findPath('1.0', '2.0')), ['m001', 'm099']);
});

test('returns null for unreachable targets and terminates on cycles', () => {
  const g = new VersionGraph();
  g.add(step('m001', '1.0', '2.0'));
  g.add(step('m002', '2.0', '1.0'));
  g.add(step('m003', '3.0', '4.0'));
  assert.equal(g.findPath('1.0', '3.0'), null);
  assert.equal(g.findPath('1.0', '9.9'), null);
});

test('same source and target yields an empty path', () => {
  const g = new VersionGraph();
  g.add(step('m001', '1.0', '2.0'));
  assert.deepEqual(ids(g.findPath('1.0', '1.0')), []);
});

test('multi-hop route through an intermediate branch', () => {
  const g = new VersionGraph();
  g.add(step('m001', '1.0', '2.0'));
  g.add(step('m002', '2.0', '3.0'));
  g.add(step('m003', '1.0', '3.0'));
  g.add(step('m004', '3.0', '4.0'));
  assert.deepEqual(ids(g.findPath('1.0', '4.0')), ['m003', 'm004']);
});
