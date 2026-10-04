import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { openSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { EventBus, InvalidInputError } from '../src/eventbus.js';

const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'cli.js');

// Acceptance 1: concurrent branches are distinguishable from real ordering.
test('concurrent branches vs real causal order', () => {
  const bus = new EventBus();
  // Three branches firing at the same physical instant on different nodes.
  bus.observe('b1', 100, 'devA');
  bus.observe('b2', 100, 'devB');
  bus.observe('b3', 100, 'devC');
  // Real order: fault f1 caused alarm a1.
  bus.observe('f1', 90, 'devA');
  bus.observe('a1', 110, 'devA');
  bus.link('f1', 'a1', 'cause');

  assert.equal(bus.query('b1', 'b2'), 'CONCURRENT');
  assert.equal(bus.query('b2', 'b3'), 'CONCURRENT');
  assert.equal(bus.query('b1', 'b3'), 'CONCURRENT');

  assert.equal(bus.query('f1', 'a1'), 'REACHABLE');
  assert.equal(bus.query('a1', 'f1'), 'NOT_REACHABLE');

  // Later timestamp without a path: undecided, never NOT_REACHABLE.
  assert.equal(bus.query('b1', 'a1'), 'UNDECIDED');
  // Earlier physical time rules out causality in that direction.
  assert.equal(bus.query('a1', 'b1'), 'NOT_REACHABLE');
});

// Acceptance 2: cycle A->B->C->A shows up in scc and reachability agrees.
test('cycle produces SCC and consistent reachability', () => {
  const bus = new EventBus();
  bus.observe('A', 1, 'n1');
  bus.observe('B', 2, 'n2');
  bus.observe('C', 3, 'n3');
  bus.observe('D', 4, 'n4');
  bus.link('A', 'B', 'config');
  bus.link('B', 'C', 'config');
  bus.link('C', 'A', 'config');
  bus.link('C', 'D', 'config');

  assert.deepEqual(bus.scc(), [['A', 'B', 'C']]);
  // Every member of the cycle reaches every other member.
  assert.equal(bus.query('A', 'B'), 'REACHABLE');
  assert.equal(bus.query('B', 'A'), 'REACHABLE');
  assert.equal(bus.query('C', 'A'), 'REACHABLE');
  // The cycle reaches D, and D cannot reach back.
  assert.equal(bus.query('A', 'D'), 'REACHABLE');
  assert.equal(bus.query('D', 'A'), 'NOT_REACHABLE');
});

// Acceptance 3: random partial orders (n <= 9) vs brute-force transitive closure.
test('random partial orders match brute-force transitive closure', () => {
  let seed = 0x2f6e2b1;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x80000000;
  };

  for (let trial = 0; trial < 200; trial += 1) {
    const n = 1 + Math.floor(rand() * 9); // 1..9 events
    const ids = Array.from({ length: n }, (_, i) => 'e' + i);
    const bus = new EventBus();
    for (const id of ids) bus.observe(id, n - Number(id.slice(1)), 'dev');

    // Random DAG: shuffle a topological order, add edges forward only.
    const order = [...ids];
    for (let i = n - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const matrix = Array.from({ length: n }, () => new Array(n).fill(false));
    const pos = new Map(order.map((id, idx) => [id, idx]));
    for (const a of ids) {
      for (const b of ids) {
        if (pos.get(a) < pos.get(b) && rand() < 0.35) {
          bus.link(a, b, 'dep');
          matrix[Number(a.slice(1))][Number(b.slice(1))] = true;
        }
      }
    }

    // Brute-force transitive closure (Warshall).
    const reach = matrix.map((row) => [...row]);
    for (let k = 0; k < n; k += 1) {
      for (let i = 0; i < n; i += 1) {
        for (let j = 0; j < n; j += 1) {
          if (reach[i][k] && reach[k][j]) reach[i][j] = true;
        }
      }
    }

    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) {
        if (i === j) continue;
        const verdict = bus.query('e' + i, 'e' + j);
        if (reach[i][j]) {
          assert.equal(verdict, 'REACHABLE', `trial ${trial}: e${i} -> e${j}`);
        } else {
          assert.notEqual(verdict, 'REACHABLE', `trial ${trial}: e${i} -/-> e${j}`);
          if (reach[j][i]) assert.equal(verdict, 'NOT_REACHABLE');
        }
      }
    }
  }
});

// Acceptance 4: rollback across checkpoints restores events, edges, queries.
test('layered checkpoints and precise rollback', () => {
  const bus = new EventBus();
  bus.observe('e1', 1, 'devA');
  bus.observe('e2', 2, 'devA');
  bus.link('e1', 'e2', 'cause');
  bus.checkpoint(); // layer 1

  bus.observe('e3', 3, 'devB');
  bus.link('e2', 'e3', 'cause');
  bus.checkpoint(); // layer 2

  bus.observe('e4', 4, 'devB');
  bus.link('e3', 'e4', 'cause');
  assert.equal(bus.query('e1', 'e4'), 'REACHABLE');

  // Undo the most recent layer: e4 and its edge disappear.
  assert.equal(bus.rollback(1), 'OK');
  assert.equal(bus.has('e4'), false);
  assert.equal(bus.query('e1', 'e3'), 'REACHABLE');
  assert.throws(() => bus.query('e1', 'e4'), InvalidInputError);

  // Undo two more layers than exist: range error, state untouched.
  assert.equal(bus.rollback(2), 'ROLLBACK_RANGE');
  assert.equal(bus.has('e3'), true);
  assert.equal(bus.query('e1', 'e3'), 'REACHABLE');
  assert.equal(bus.depth, 1);

  // Undo the last layer: back to the initial two-event state.
  assert.equal(bus.rollback(1), 'OK');
  assert.equal(bus.has('e3'), false);
  assert.equal(bus.query('e1', 'e2'), 'REACHABLE');
  assert.equal(bus.query('e2', 'e1'), 'NOT_REACHABLE');
  assert.equal(bus.depth, 0);
  assert.equal(bus.rollback(1), 'ROLLBACK_RANGE');
});

// Acceptance 5: duplicate id, missing endpoints, negative k -> INVALID_INPUT.
test('invalid inputs are rejected', () => {
  const bus = new EventBus();
  bus.observe('x', 1, 'devA');

  assert.throws(() => bus.observe('x', 2, 'devA'), (err) => err.code === 'INVALID_INPUT');
  assert.throws(() => bus.link('x', 'ghost'), (err) => err.code === 'INVALID_INPUT');
  assert.throws(() => bus.link('ghost', 'x'), (err) => err.code === 'INVALID_INPUT');
  assert.throws(() => bus.rollback(-1), (err) => err.code === 'INVALID_INPUT');
  assert.throws(() => bus.rollback(1.5), (err) => err.code === 'INVALID_INPUT');
  assert.throws(() => bus.observe('y', Number.NaN, 'devA'), (err) => err.code === 'INVALID_INPUT');
  assert.throws(() => bus.query('x', 'ghost'), (err) => err.code === 'INVALID_INPUT');
});

// SCC output: only components of size > 1, members sorted, deterministic order.
test('scc filters singletons and sorts members', () => {
  const bus = new EventBus();
  for (const id of ['m1', 'm2', 'm3', 's1', 's2', 'solo']) bus.observe(id, 0, 'dev');
  bus.link('m2', 'm1', 'cfg');
  bus.link('m1', 'm3', 'cfg');
  bus.link('m3', 'm2', 'cfg');
  bus.link('s1', 's2', 'cfg');
  bus.link('s2', 's1', 'cfg');
  assert.deepEqual(bus.scc(), [
    ['m1', 'm2', 'm3'],
    ['s1', 's2'],
  ]);
});

// CLI end-to-end: JSONL in, verdicts out.
test('cli processes jsonl replay', () => {
  const input = [
    JSON.stringify({ op: 'observe', id: 'e1', ts: 1, node: 'devA' }),
    JSON.stringify({ op: 'observe', id: 'e2', ts: 2, node: 'devB' }),
    JSON.stringify({ op: 'observe', id: 'e3', ts: 2, node: 'devC' }),
    JSON.stringify({ op: 'link', a: 'e1', b: 'e2', kind: 'cause' }),
    JSON.stringify({ op: 'query', a: 'e1', b: 'e2' }),
    JSON.stringify({ op: 'query', a: 'e2', b: 'e3' }),
    JSON.stringify({ op: 'query', a: 'e1', b: 'e3' }),
    JSON.stringify({ op: 'link', a: 'e2', b: 'e1' }),
    JSON.stringify({ op: 'scc' }),
    JSON.stringify({ op: 'checkpoint' }),
    JSON.stringify({ op: 'rollback', k: 2 }),
    JSON.stringify({ op: 'rollback', k: -3 }),
    JSON.stringify({ op: 'observe', id: 'e1', ts: 5, node: 'devA' }),
    'not json',
  ].join('\n');

  const dir = mkdtempSync(path.join(tmpdir(), 'eventbus-cli-'));
  const inputFile = path.join(dir, 'input.jsonl');
  const outputFile = path.join(dir, 'output.txt');
  writeFileSync(inputFile, input + '\n');
  const outFd = openSync(outputFile, 'w');
  const result = spawnSync(process.execPath, [cliPath, inputFile], {
    stdio: ['ignore', outFd, 'pipe'],
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const stdout = readFileSync(outputFile, 'utf8');
  assert.deepEqual(stdout.trim().split('\n'), [
    'OK',
    'OK',
    'OK',
    'OK',
    'REACHABLE',
    'CONCURRENT',
    'UNDECIDED',
    'OK',
    '[["e1","e2"]]',
    'OK',
    'ROLLBACK_RANGE',
    'INVALID_INPUT',
    'INVALID_INPUT',
    'INVALID_INPUT',
  ]);
});
