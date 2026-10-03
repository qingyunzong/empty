'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Platform, PlatformError } = require('../src/platform');

test('DAG dependencies are respected and events are ordered', () => {
  const p = new Platform({ cpu: 4, mem: 4 });
  p.submit({ id: 'raw', bytes: 5 });
  p.submit({ id: 'clean', deps: ['raw'], bytes: 3 });
  p.submit({ id: 'report', deps: ['clean'], bytes: 2 });
  const { events, completed } = p.schedule();
  assert.deepEqual(completed, ['clean', 'raw', 'report']);
  const starts = events.filter((e) => e.type === 'start').map((e) => e.id);
  assert.deepEqual(starts, ['raw', 'clean', 'report']);
});

test('resource constraints limit concurrency on the single machine', () => {
  const p = new Platform({ cpu: 2, mem: 8 });
  p.submit({ id: 'a', cpu: 2, duration: 5 });
  p.submit({ id: 'b', cpu: 2, duration: 5 });
  const { events } = p.schedule();
  const startA = events.find((e) => e.type === 'start' && e.id === 'a');
  const startB = events.find((e) => e.type === 'start' && e.id === 'b');
  assert.equal(startA.time, 0);
  assert.equal(startB.time, 5, 'b must wait for cpu to free up');
});

test('failed nodes retry and then complete', () => {
  const p = new Platform({ cpu: 2, mem: 2 });
  p.submit({ id: 'flaky', failures: 2, retries: 2, bytes: 4 });
  const { events, completed } = p.schedule();
  assert.deepEqual(completed, ['flaky']);
  assert.equal(events.filter((e) => e.type === 'failure').length, 2);
  assert.equal(events.filter((e) => e.type === 'retry').length, 2);
  assert.equal(p.bytesOf('default'), 4);
});

test('exhausted retries mark the node failed but dependents stay pending, not unsatisfiable', () => {
  const p = new Platform({ cpu: 2, mem: 2 });
  p.submit({ id: 'bad', failures: 5, retries: 1 });
  p.submit({ id: 'child', deps: ['bad'] });
  p.schedule();
  assert.equal(p.nodes.get('bad').status, 'failed');
  assert.equal(p.nodes.get('child').status, 'pending');
});

test('pending dependency on a not-yet-submitted node is not unsatisfiable', () => {
  const p = new Platform({ cpu: 2, mem: 2 });
  p.submit({ id: 'derived', deps: ['upstream'] });
  let result = p.schedule();
  assert.equal(p.nodes.get('derived').status, 'pending');
  assert.deepEqual(result.completed, []);
  p.submit({ id: 'upstream', bytes: 2 });
  result = p.schedule();
  assert.deepEqual(result.completed, ['derived', 'upstream']);
});

test('cross-owner fairness: least completed bytes first', () => {
  const p = new Platform({ cpu: 1, mem: 1 });
  p.submit({ id: 'a1', owner: 'alice', bytes: 1 });
  p.submit({ id: 'a2', owner: 'alice', bytes: 1 });
  p.submit({ id: 'b1', owner: 'bob', bytes: 1 });
  const { events } = p.schedule();
  const order = events.filter((e) => e.type === 'complete').map((e) => e.id);
  assert.deepEqual(order, ['a1', 'b1', 'a2']);
});

test('aging prevents starvation of long-waiting owners', () => {
  const p = new Platform({ cpu: 1, mem: 1, agingRate: 10 });
  p.submit({ id: 'b1', owner: 'bob', bytes: 1, duration: 1 });
  // bob already has 4 completed bytes, so on raw fairness alice would win
  // forever; enough waited time must tip the aged key back to bob.
  p.ownerBytes.set('bob', 4);
  p.time = 5;
  p.submit({ id: 'a1', owner: 'alice', bytes: 1, duration: 1 });
  const { events } = p.schedule();
  const order = events.filter((e) => e.type === 'complete').map((e) => e.id);
  assert.equal(order[0], 'b1');
});

test('quota blocks nodes once owner budget is exhausted', () => {
  const p = new Platform({ cpu: 4, mem: 4, quotas: { alice: 5 } });
  p.submit({ id: 'a1', owner: 'alice', bytes: 3 });
  p.submit({ id: 'a2', owner: 'alice', bytes: 3 });
  const { completed } = p.schedule();
  assert.deepEqual(completed, ['a1']);
  assert.equal(p.nodes.get('a2').status, 'pending');
});

// Acceptance 1: for n<=10 random DAGs, the scheduler completes the maximum
// number of nodes, cross-checked against exhaustive enumeration.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function maxCompletableCount(nodes, quotas) {
  const n = nodes.length;
  const idx = new Map(nodes.map((node, i) => [node.id, i]));
  let best = 0;
  for (let mask = 0; mask < 1 << n; mask++) {
    let ok = true;
    let count = 0;
    const bytesByOwner = {};
    for (let i = 0; i < n && ok; i++) {
      if (!(mask & (1 << i))) continue;
      count++;
      for (const dep of nodes[i].deps) {
        const j = idx.get(dep);
        if (j === undefined || !(mask & (1 << j))) {
          ok = false;
          break;
        }
      }
      bytesByOwner[nodes[i].owner] = (bytesByOwner[nodes[i].owner] || 0) + nodes[i].bytes;
    }
    if (!ok) continue;
    for (const [owner, bytes] of Object.entries(bytesByOwner)) {
      if (bytes > (quotas[owner] ?? Infinity)) {
        ok = false;
        break;
      }
    }
    if (ok && count > best) best = count;
  }
  return best;
}

test('acceptance: scheduler matches exhaustive enumeration of max completable (n<=10)', () => {
  const owners = ['alice', 'bob', 'carol'];
  let checked = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const rand = mulberry32(seed);
    const n = 2 + Math.floor(rand() * 9); // 2..10
    const nodes = [];
    const totals = {};
    for (let i = 0; i < n; i++) {
      const deps = [];
      for (let j = 0; j < i; j++) {
        if (rand() < 0.3) deps.push(`n${j}`);
      }
      const owner = owners[Math.floor(rand() * owners.length)];
      const bytes = 1 + Math.floor(rand() * 4);
      totals[owner] = (totals[owner] || 0) + bytes;
      nodes.push({
        id: `n${i}`,
        owner,
        deps,
        bytes,
        cpu: 1 + Math.floor(rand() * 2),
        mem: 1 + Math.floor(rand() * 2),
        duration: 1 + Math.floor(rand() * 3),
      });
    }
    const quotas = {};
    for (const owner of owners) {
      const total = totals[owner] || 0;
      if (total === 0) continue;
      const maxNode = Math.max(...nodes.filter((x) => x.owner === owner).map((x) => x.bytes));
      const factor = 0.4 + rand() * 0.6;
      quotas[owner] = Math.max(maxNode, Math.floor(total * factor));
    }
    const p = new Platform({ cpu: 4, mem: 4, quotas });
    for (const node of nodes) p.submit(node);
    const { completed } = p.schedule();
    const expected = maxCompletableCount(nodes, quotas);
    assert.equal(
      completed.length,
      expected,
      `seed=${seed} completed=${completed.length} expected=${expected}`,
    );
    checked++;
  }
  assert.ok(checked >= 300);
});

test('domain errors: duplicate submit, cycle, oversize resource', () => {
  const p = new Platform({ cpu: 2, mem: 2 });
  p.submit({ id: 'x' });
  assert.throws(() => p.submit({ id: 'x' }), (e) => e instanceof PlatformError && e.code === 'DUPLICATE_SUBMIT');
  assert.throws(() => p.submit({ id: 'big', cpu: 3 }), (e) => e.code === 'RESOURCE_EXCEEDS_MACHINE');
  p.submit({ id: 'y', deps: ['x'] });
  assert.throws(() => p.submit({ id: 'z', deps: ['z'] }), (e) => e.code === 'CYCLE_DEPENDENCY');
  assert.throws(() => p.correct('x', { deps: ['y'] }), (e) => e.code === 'CYCLE_DEPENDENCY');
});
