'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runToollife } = require('../src/engine');

// ---------- independent reference model (acceptance 1 cross-check) ----------
// Deliberately re-implemented with a different structure: index-keyed records
// and a single pass per phase, no shared code with the engine.
function referenceFinalLife(config, operations, undoOpIdsInOrder) {
  const coefOf = (m) => (config.materials && config.materials[m] !== undefined ? config.materials[m] : 1);
  const toolCfg = config.tools[0];
  let life = toolCfg.life === undefined ? toolCfg.max_life : toolCfg.life;
  const max = toolCfg.max_life;
  const recs = new Map(); // op_id -> {idx, d, live, cut}
  const seen = new Set();
  operations.forEach((op, idx) => {
    if (seen.has(op.op_id)) return;
    seen.add(op.op_id);
    if (op.type === 'setup') {
      life = max;
      recs.set(op.op_id, { idx, d: 0, live: true, cut: false });
    } else if (op.type === 'cut') {
      const d = op.amount * coefOf(op.material);
      if (life < 0) {
        recs.set(op.op_id, { idx, d, live: false, cut: true });
      } else {
        life -= d;
        recs.set(op.op_id, { idx, d, live: true, cut: true });
      }
    } else if (op.type === 'regrind') {
      life = Math.min(max, life + op.restore);
      recs.set(op.op_id, { idx, d: 0, live: true, cut: false });
    }
  });
  const reversed = new Set();
  for (const id of undoOpIdsInOrder) {
    if (reversed.has(id)) continue;
    const r = recs.get(id);
    if (!r || !r.live || !r.cut) continue;
    let dep = false;
    for (const [otherId, o] of recs) {
      if (o.live && o.idx > r.idx && !reversed.has(otherId)) { dep = true; break; }
    }
    reversed.add(id);
    r.live = false;
    life = dep ? Math.min(max, life + r.d) : life + r.d;
  }
  return life;
}

// ---------- deterministic generator ----------
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function genOps(rand, n) {
  const ops = [];
  for (let i = 0; i < n; i++) {
    const r = rand();
    if (r < 0.55) {
      ops.push({ op_id: `op${i}`, tool_id: 'T1', type: 'cut', material: rand() < 0.5 ? 'steel' : 'aluminum', amount: 5 + Math.floor(rand() * 30) });
    } else if (r < 0.85) {
      ops.push({ op_id: `op${i}`, tool_id: 'T1', type: 'regrind', restore: 5 + Math.floor(rand() * 25) });
    } else {
      ops.push({ op_id: `op${i}`, tool_id: 'T1', type: 'setup' });
    }
  }
  return ops;
}

function* subsets(arr) {
  const n = arr.length;
  for (let mask = 0; mask < (1 << n); mask++) {
    const out = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) out.push(arr[i]);
    yield out;
  }
}

const CONFIG = { materials: { steel: 1, aluminum: 0.5 }, tools: [{ tool_id: 'T1', max_life: 100 }] };

test('acceptance 1: enumerate legal undo sets for n<=10 ops, final life matches reference', () => {
  let checked = 0;
  for (const seed of [1, 7, 42, 1337]) {
    const rand = mulberry32(seed);
    for (let n = 1; n <= 10; n++) {
      const ops = genOps(rand, n);
      // legal undo targets: applied cuts (engine view)
      const { history } = runToollife(CONFIG, ops, []);
      const appliedCuts = history
        .filter((h) => h.kind === 'op' && h.type === 'cut' && (h.status === 'APPLIED' || h.status === 'OVERUSE'))
        .map((h) => h.op_id);
      for (const subset of subsets(appliedCuts)) {
        for (const order of ['desc', 'asc']) {
          const undoIds = order === 'desc' ? [...subset].reverse() : subset;
          const undos = undoIds.map((id, k) => ({ undo_id: `u${k}`, op_id: id }));
          const { toolsState } = runToollife(CONFIG, ops, undos);
          const expected = referenceFinalLife(CONFIG, ops, undoIds);
          assert.equal(toolsState[0].life, expected,
            `seed=${seed} n=${n} order=${order} undos=[${undoIds}] ops=${JSON.stringify(ops)}`);
          assert.equal(toolsState[0].overused, expected < 0);
          checked++;
        }
      }
    }
  }
  assert.ok(checked > 1000, `expected substantial enumeration, got ${checked}`);
});

test('acceptance 2: cut -> regrind -> undo cut is dependency-rejected, compensated path', () => {
  const ops = [
    { op_id: 'c1', tool_id: 'T1', type: 'cut', material: 'steel', amount: 30 },
    { op_id: 'r1', tool_id: 'T1', type: 'regrind', restore: 20 },
  ];
  const { toolsState, history } = runToollife(CONFIG, ops, [{ undo_id: 'u1', op_id: 'c1' }]);
  const undo = history.find((h) => h.kind === 'undo');
  assert.equal(undo.status, 'COMPENSATED');
  assert.equal(undo.reason, 'dependency');
  const cmp = history.find((h) => h.kind === 'compensate_op');
  assert.ok(cmp, 'compensate_op record must exist');
  assert.equal(cmp.op_id, 'c1');
  assert.equal(cmp.amount, 30);
  assert.equal(cmp.status, 'APPLIED');
  // 100 - 30 + 20 = 90, compensation min(100, 90+30) = 100
  assert.equal(toolsState[0].life, 100);
});

test('acceptance 2b: direct undo of the latest cut is an exact inverse', () => {
  const ops = [
    { op_id: 'c1', tool_id: 'T1', type: 'cut', material: 'steel', amount: 30 },
    { op_id: 'c2', tool_id: 'T1', type: 'cut', material: 'aluminum', amount: 20 }, // -10
  ];
  const { toolsState, history } = runToollife(CONFIG, ops, [{ op_id: 'c2' }]);
  assert.equal(history.find((h) => h.kind === 'undo').status, 'UNDONE');
  assert.equal(toolsState[0].life, 70);
});

test('acceptance 3: repeated undo of the same op is NOOP and changes nothing', () => {
  const ops = [{ op_id: 'c1', tool_id: 'T1', type: 'cut', material: 'steel', amount: 25 }];
  const { toolsState, history } = runToollife(CONFIG, ops, [
    { undo_id: 'u1', op_id: 'c1' },
    { undo_id: 'u1', op_id: 'c1' },   // same undo_id replayed
    { undo_id: 'u2', op_id: 'c1' },   // different undo_id, same target
  ]);
  const undos = history.filter((h) => h.kind === 'undo');
  assert.deepEqual(undos.map((u) => u.status), ['UNDONE', 'NOOP', 'NOOP']);
  assert.equal(undos[1].reason, 'duplicate_undo');
  assert.equal(undos[2].reason, 'already_reversed');
  assert.equal(toolsState[0].life, 100); // deducted once, restored once
});

test('acceptance 3b: compensation cannot be applied twice', () => {
  const ops = [
    { op_id: 'c1', tool_id: 'T1', type: 'cut', material: 'steel', amount: 40 },
    { op_id: 'g1', tool_id: 'T1', type: 'regrind', restore: 10 },
  ];
  const { toolsState, history } = runToollife(CONFIG, ops, [
    { undo_id: 'u1', op_id: 'c1' },
    { undo_id: 'u2', op_id: 'c1' },
  ]);
  const undos = history.filter((h) => h.kind === 'undo');
  assert.deepEqual(undos.map((u) => u.status), ['COMPENSATED', 'NOOP']);
  assert.equal(history.filter((h) => h.kind === 'compensate_op').length, 1);
  // 100 - 40 + 10 = 70, one compensation min(100, 70+40) = 100
  assert.equal(toolsState[0].life, 100);
});

test('acceptance 4: OVERUSE forces the cut, blocks further cuts until regrind or setup', () => {
  const config = { materials: { steel: 1 }, tools: [{ tool_id: 'T1', max_life: 100, life: 30 }] };
  const ops = [
    { op_id: 'c1', tool_id: 'T1', type: 'cut', material: 'steel', amount: 50 }, // -> -20 OVERUSE
    { op_id: 'c2', tool_id: 'T1', type: 'cut', material: 'steel', amount: 10 }, // blocked
    { op_id: 'g1', tool_id: 'T1', type: 'regrind', restore: 50 },               // -> 30
    { op_id: 'c3', tool_id: 'T1', type: 'cut', material: 'steel', amount: 10 }, // -> 20
  ];
  const { toolsState, history } = runToollife(config, ops, []);
  const byId = Object.fromEntries(history.filter((h) => h.kind === 'op').map((h) => [h.op_id, h]));
  assert.equal(byId.c1.status, 'OVERUSE');
  assert.equal(byId.c1.life_after, -20);
  assert.equal(byId.c2.status, 'BLOCKED_OVERUSE');
  assert.equal(byId.c2.life_after, -20);
  assert.equal(byId.c3.status, 'APPLIED');
  assert.equal(toolsState[0].life, 20);
  assert.equal(toolsState[0].overused, false);
});

test('acceptance 4b: setup (tool change) also clears the OVERUSE ban', () => {
  const config = { materials: { steel: 1 }, tools: [{ tool_id: 'T1', max_life: 100, life: 10 }] };
  const ops = [
    { op_id: 'c1', tool_id: 'T1', type: 'cut', material: 'steel', amount: 40 }, // -> -30 OVERUSE
    { op_id: 'c2', tool_id: 'T1', type: 'cut', material: 'steel', amount: 5 },  // blocked
    { op_id: 's1', tool_id: 'T1', type: 'setup' },                              // -> 100
    { op_id: 'c3', tool_id: 'T1', type: 'cut', material: 'steel', amount: 5 },  // -> 95
  ];
  const { toolsState, history } = runToollife(config, ops, []);
  const byId = Object.fromEntries(history.filter((h) => h.kind === 'op').map((h) => [h.op_id, h]));
  assert.equal(byId.c2.status, 'BLOCKED_OVERUSE');
  assert.equal(byId.c3.status, 'APPLIED');
  assert.equal(toolsState[0].life, 95);
});

test('idempotency: replayed op_id applies only once', () => {
  const ops = [
    { op_id: 'c1', tool_id: 'T1', type: 'cut', material: 'steel', amount: 25 },
    { op_id: 'c1', tool_id: 'T1', type: 'cut', material: 'steel', amount: 25 },
  ];
  const { toolsState, history } = runToollife(CONFIG, ops, []);
  const statuses = history.filter((h) => h.kind === 'op').map((h) => h.status);
  assert.deepEqual(statuses, ['APPLIED', 'NOOP']);
  assert.equal(toolsState[0].life, 75);
});

test('undo of non-cut or unknown op is rejected', () => {
  const ops = [{ op_id: 'g1', tool_id: 'T1', type: 'regrind', restore: 10 }];
  const { history } = runToollife(CONFIG, ops, [{ op_id: 'g1' }, { op_id: 'nope' }]);
  const undos = history.filter((h) => h.kind === 'undo');
  assert.equal(undos[0].status, 'REJECTED');
  assert.equal(undos[0].reason, 'not_undoable');
  assert.equal(undos[1].status, 'REJECTED');
  assert.equal(undos[1].reason, 'unknown_op');
});

test('undo of a BLOCKED_OVERUSE cut is rejected (nothing to reverse)', () => {
  const config = { materials: { steel: 1 }, tools: [{ tool_id: 'T1', max_life: 100, life: 5 }] };
  const ops = [
    { op_id: 'c1', tool_id: 'T1', type: 'cut', material: 'steel', amount: 20 }, // OVERUSE -> -15
    { op_id: 'c2', tool_id: 'T1', type: 'cut', material: 'steel', amount: 5 },  // blocked
  ];
  const { toolsState, history } = runToollife(config, ops, [{ op_id: 'c2' }]);
  const undo = history.find((h) => h.kind === 'undo');
  assert.equal(undo.status, 'REJECTED');
  assert.equal(undo.reason, 'not_applied');
  assert.equal(toolsState[0].life, -15);
});

test('multi-tool isolation', () => {
  const config = { materials: { steel: 1 }, tools: [{ tool_id: 'T1', max_life: 100 }, { tool_id: 'T2', max_life: 50 }] };
  const ops = [
    { op_id: 'a', tool_id: 'T1', type: 'cut', material: 'steel', amount: 10 },
    { op_id: 'b', tool_id: 'T2', type: 'cut', material: 'steel', amount: 10 },
  ];
  const { toolsState } = runToollife(config, ops, [{ op_id: 'a' }]);
  assert.deepEqual(toolsState.map((t) => t.life), [100, 40]);
});
