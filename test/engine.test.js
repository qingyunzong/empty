'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine } = require('../src/engine');
const { parse, collectDeps } = require('../src/formula');

// ---------------------------------------------------------------------------
// Independent reference implementation: naive whole-graph fixed-point
// evaluation with DFS cycle detection. Shares only the formula parser.
// ---------------------------------------------------------------------------
function referenceState(tagDefs) {
  const values = new Map();
  const invalid = new Set();
  const visiting = new Set();
  const done = new Set();

  function evalAst(node, resolve) {
    switch (node.kind) {
      case 'num': return node.value;
      case 'ref': return resolve(node.name);
      case 'neg': return -evalAst(node.operand, resolve);
      case 'bin': {
        const l = evalAst(node.left, resolve);
        const r = evalAst(node.right, resolve);
        if (node.op === '+') return l + r;
        if (node.op === '-') return l - r;
        if (node.op === '*') return l * r;
        if (node.op === '/') {
          if (r === 0) throw new Error('div0');
          return l / r;
        }
        throw new Error('bad op');
      }
      default: throw new Error('bad node');
    }
  }

  function visit(name) {
    if (done.has(name)) return;
    if (visiting.has(name)) { invalid.add(name); done.add(name); return; }
    const def = tagDefs.get(name);
    if (!def) { invalid.add(name); done.add(name); return; }
    visiting.add(name);
    if (def.type === 'const') {
      values.set(name, def.value);
    } else {
      const ast = parse(def.expr);
      for (const dep of collectDeps(ast)) {
        if (tagDefs.has(dep)) visit(dep);
      }
      let bad = false;
      let value = 0;
      try {
        value = evalAst(ast, (dep) => {
          if (!tagDefs.has(dep) || invalid.has(dep)) { bad = true; return 0; }
          return values.get(dep);
        });
      } catch {
        bad = true;
      }
      if (bad || !Number.isFinite(value)) invalid.add(name);
      else values.set(name, value);
    }
    visiting.delete(name);
    done.add(name);
  }

  for (const name of [...tagDefs.keys()].sort()) visit(name);
  return { values, invalid };
}

function engineDefs(engine) {
  const defs = new Map();
  for (const [name, tag] of engine.tags) {
    defs.set(name, tag.type === 'const'
      ? { type: 'const', value: tag.value }
      : { type: 'formula', expr: tag.expr });
  }
  return defs;
}

function assertMatchesReference(engine) {
  const ref = referenceState(engineDefs(engine));
  assert.deepEqual(Object.fromEntries(engine.values), Object.fromEntries(ref.values),
    'values must match reference fixed-point');
  assert.deepEqual([...engine.invalid].sort(), [...ref.invalid].sort(),
    'invalid set must match reference fixed-point');
}

function run(engine, commands) {
  return commands.map((cmd) => engine.execute(cmd));
}

// ---------------------------------------------------------------------------

test('multi-level updates match independent reference fixed-point', () => {
  const engine = new Engine();
  const records = run(engine, [
    { op: 'upsert', tag: 'base', type: 'const', value: 2 },
    { op: 'upsert', tag: 'rate', type: 'const', value: 1.5 },
    { op: 'upsert', tag: 'level1', type: 'formula', expr: 'base * rate' },
    { op: 'upsert', tag: 'level2', type: 'formula', expr: '(level1 + 4) / 2' },
    { op: 'upsert', tag: 'level3', type: 'formula', expr: 'level2 * level2 - base' },
    { op: 'upsert', tag: 'island', type: 'const', value: 99 },
    { op: 'upsert', tag: 'island2', type: 'formula', expr: 'island - 9' },
  ]);
  assertMatchesReference(engine);
  assert.equal(engine.values.get('level1'), 3);
  assert.equal(engine.values.get('level2'), 3.5);
  assert.equal(engine.values.get('level3'), 10.25);

  // Incremental: touching `base` must not recompute the unrelated branch.
  const rec = engine.execute({ op: 'set', tag: 'base', value: 4 });
  assert.deepEqual(rec.recomputed, ['base', 'level1', 'level2', 'level3']);
  assert.ok(!rec.recomputed.includes('island'));
  assert.ok(!rec.recomputed.includes('island2'));
  assertMatchesReference(engine);
  assert.equal(engine.values.get('level1'), 6);
  assert.equal(engine.values.get('level2'), 5);
  assert.equal(engine.values.get('level3'), 21);

  // diff reports exactly the changed tags
  assert.deepEqual(rec.diff, {
    base: { from: 2, to: 4 },
    level1: { from: 3, to: 6 },
    level2: { from: 3.5, to: 5 },
    level3: { from: 10.25, to: 21 },
  });
  assert.ok(records.every((r) => r.version > 0));
});

test('cycle invalidates downstream only; breaking and undo restore topology', () => {
  const engine = new Engine();
  run(engine, [
    { op: 'upsert', tag: 'a', type: 'const', value: 1 },
    { op: 'upsert', tag: 'b', type: 'formula', expr: 'a + 1' },
    { op: 'upsert', tag: 'c', type: 'formula', expr: 'b * 10' },
    { op: 'upsert', tag: 'free', type: 'const', value: 7 },
    { op: 'upsert', tag: 'freeChild', type: 'formula', expr: 'free * 2' },
  ]);
  assertMatchesReference(engine);

  // Manufacture a cycle: a depends on b.
  const cyc = engine.execute({ op: 'upsert', tag: 'a', type: 'formula', expr: 'b + 1' });
  assert.deepEqual([...engine.invalid].sort(), ['a', 'b', 'c']);
  assert.equal(engine.values.get('free'), 7, 'unrelated branch untouched');
  assert.equal(engine.values.get('freeChild'), 14, 'unrelated branch untouched');
  assert.deepEqual(cyc.recomputed, ['a', 'b', 'c'], 'only affected subgraph recomputed');
  assertMatchesReference(engine);

  // Break the cycle: a becomes a constant again; everything recovers.
  engine.execute({ op: 'upsert', tag: 'a', type: 'const', value: 5 });
  assert.deepEqual([...engine.invalid].sort(), []);
  assert.equal(engine.values.get('b'), 6);
  assert.equal(engine.values.get('c'), 60);
  assertMatchesReference(engine);

  // Undo restores the old (cyclic) topology and its invalid set.
  engine.execute({ op: 'undo' });
  assert.deepEqual([...engine.invalid].sort(), ['a', 'b', 'c']);
  assert.equal(engine.tags.get('a').type, 'formula');
  assertMatchesReference(engine);

  // Undo again returns to the pre-cycle topology.
  engine.execute({ op: 'undo' });
  assert.deepEqual([...engine.invalid].sort(), []);
  assert.equal(engine.tags.get('a').type, 'const');
  assert.equal(engine.values.get('c'), 20);
  assertMatchesReference(engine);

  // Redo re-applies the cycle.
  engine.execute({ op: 'redo' });
  assert.deepEqual([...engine.invalid].sort(), ['a', 'b', 'c']);
  assertMatchesReference(engine);
});

test('parallel (diamond) dependencies and division by zero', () => {
  const engine = new Engine();
  run(engine, [
    { op: 'upsert', tag: 'm', type: 'const', value: 2 },
    { op: 'upsert', tag: 'left', type: 'formula', expr: 'm + 1' },
    { op: 'upsert', tag: 'right', type: 'formula', expr: 'm * 3' },
    { op: 'upsert', tag: 'join', type: 'formula', expr: 'left + right' },
    { op: 'upsert', tag: 'zero', type: 'const', value: 0 },
    { op: 'upsert', tag: 'boom', type: 'formula', expr: 'm / zero' },
    { op: 'upsert', tag: 'boomChild', type: 'formula', expr: 'boom + 1' },
  ]);
  assert.equal(engine.values.get('join'), 9);
  assert.deepEqual([...engine.invalid].sort(), ['boom', 'boomChild']);
  assertMatchesReference(engine);

  // Diamond recomputes exactly once per node, deterministic topo order.
  const rec = engine.execute({ op: 'set', tag: 'm', value: 4 });
  assert.deepEqual(rec.recomputed, ['boom', 'boomChild', 'join', 'left', 'm', 'right']);
  assert.equal(engine.values.get('join'), 17);
  assertMatchesReference(engine);

  // Fix the divisor: boom branch recovers, nothing else changes.
  const fix = engine.execute({ op: 'set', tag: 'zero', value: 2 });
  assert.deepEqual(fix.recomputed, ['boom', 'boomChild', 'zero']);
  assert.equal(engine.values.get('boom'), 2);
  assert.equal(engine.values.get('boomChild'), 3);
  assert.deepEqual([...engine.invalid].sort(), []);
  assertMatchesReference(engine);
});

test('unknown dependency invalidates; defining it later recovers downstream', () => {
  const engine = new Engine();
  engine.execute({ op: 'upsert', tag: 'uses_ghost', type: 'formula', expr: 'ghost * 2' });
  engine.execute({ op: 'upsert', tag: 'downstream', type: 'formula', expr: 'uses_ghost + 1' });
  assert.deepEqual([...engine.invalid].sort(), ['downstream', 'uses_ghost']);
  assertMatchesReference(engine);

  const rec = engine.execute({ op: 'upsert', tag: 'ghost', type: 'const', value: 21 });
  assert.deepEqual(rec.recomputed, ['downstream', 'ghost', 'uses_ghost']);
  assert.equal(engine.values.get('uses_ghost'), 42);
  assert.equal(engine.values.get('downstream'), 43);
  assert.deepEqual([...engine.invalid].sort(), []);
  assertMatchesReference(engine);

  // Removing the dependency re-invalidates the downstream chain.
  engine.execute({ op: 'remove', tag: 'ghost' });
  assert.deepEqual([...engine.invalid].sort(), ['downstream', 'uses_ghost']);
  assertMatchesReference(engine);
});

test('certificate is deterministic: seq, topo order, canonical hash', () => {
  const build = () => {
    const engine = new Engine();
    run(engine, [
      { op: 'upsert', tag: 'zeta', type: 'const', value: 3 },
      { op: 'upsert', tag: 'alpha', type: 'const', value: 1 },
      { op: 'upsert', tag: 'mid', type: 'formula', expr: 'alpha + zeta' },
      { op: 'upsert', tag: 'top', type: 'formula', expr: 'mid * 2' },
    ]);
    return engine;
  };
  const e1 = build();
  const e2 = build();
  const c1 = e1.certificate(1);
  const c2 = e2.certificate(1);
  assert.deepEqual(c1, c2, 'same commands must yield identical certificates');
  assert.deepEqual(c1.topo, ['alpha', 'zeta', 'mid', 'top'],
    'topological order tie-broken by tag name');
  assert.match(c1.hash, /^[0-9a-f]{64}$/);

  // Hash changes when values change.
  e1.execute({ op: 'set', tag: 'alpha', value: 2 });
  assert.notEqual(e1.certificate(1).hash, c1.hash);
});

test('undo/redo across set and remove; new edit clears redo stack', () => {
  const engine = new Engine();
  run(engine, [
    { op: 'upsert', tag: 'x', type: 'const', value: 1 },
    { op: 'upsert', tag: 'y', type: 'formula', expr: 'x * 2' },
    { op: 'set', tag: 'x', value: 10 },
  ]);
  assert.equal(engine.values.get('y'), 20);

  engine.execute({ op: 'undo' }); // undo set
  assert.equal(engine.values.get('y'), 2);
  engine.execute({ op: 'undo' }); // undo upsert y
  assert.equal(engine.tags.has('y'), false);
  engine.execute({ op: 'redo' }); // redo upsert y
  assert.equal(engine.values.get('y'), 2);

  engine.execute({ op: 'undo' }); // undo upsert y again
  engine.execute({ op: 'set', tag: 'x', value: 5 }); // diverge: clears redo
  engine.execute({ op: 'redo' }); // no-op
  assert.equal(engine.tags.has('y'), false);
  assert.equal(engine.values.get('x'), 5);
  assertMatchesReference(engine);
});
