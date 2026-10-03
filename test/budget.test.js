import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { solve } from '../src/solver.js';

const medium = JSON.parse(
  readFileSync(new URL('../examples/medium.json', import.meta.url), 'utf8'));

test('预算阈值附近：耗尽为 unknown 且列出未决任务，足够则最优', () => {
  const full = solve(medium, { budget: 1_000_000 });
  assert.equal(full.status, 'optimal');
  const nodes = full.stats.nodes;
  assert.ok(nodes > 5, `expected a non-trivial search tree, got ${nodes} nodes`);

  // Budget exactly at the required node count: search completes.
  const at = solve(medium, { budget: nodes });
  assert.equal(at.status, 'optimal');
  assert.equal(at.makespan, full.makespan);
  assert.equal(at.totalTravel, full.totalTravel);

  // One node below the threshold: budget exhausted -> unknown.
  const under = solve(medium, { budget: nodes - 1 });
  assert.equal(under.status, 'unknown');
  assert.ok(Array.isArray(under.pending));
  assert.ok(under.pending.length > 0, 'pending tasks must be listed');
  for (const p of under.pending) {
    assert.ok(typeof p.task === 'string');
    assert.ok(Array.isArray(p.personDomain));
    assert.ok(Array.isArray(p.startDomain));
  }
});
