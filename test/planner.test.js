import test from 'node:test';
import assert from 'node:assert/strict';
import { processJsonl } from '../src/cli-core.js';
import { Planner, PlannerError, INF } from '../src/planner.js';

// ---------- helpers ----------

function run(planner, cmds) {
  return cmds.map((c) => planner.execute(c));
}

function ok(planner, cmd) {
  return planner.execute(cmd);
}

function expectError(planner, cmd, code) {
  assert.throws(() => planner.execute(cmd), (err) => err instanceof PlannerError && err.code === code);
}

// Brute-force min s-t cut: enumerate every subset of orders and slots on the
// source side of the cut. Exact oracle for max flow (max-flow min-cut theorem).
function bruteForceMinCut(state) {
  const orders = [...state.orders.values()];
  const slots = [...state.slots.values()];
  const slotCap = slots.map((s) => s.capacity * (state.machineFactors.get(s.machine) ?? 1));
  const links = [...state.links.values()];
  const oIdx = new Map(orders.map((o, i) => [o.id, i]));
  const sIdx = new Map(slots.map((s, j) => [s.id, j]));
  const n = orders.length;
  const m = slots.length;
  let best = Infinity;
  for (let mo = 0; mo < 1 << n; mo++) {
    for (let ms = 0; ms < 1 << m; ms++) {
      let cut = 0;
      let infinite = false;
      for (let i = 0; i < n; i++) if (!(mo & (1 << i))) cut += orders[i].demand;
      for (let j = 0; j < m; j++) if (ms & (1 << j)) cut += slotCap[j];
      for (const l of links) {
        if (mo & (1 << oIdx.get(l.order)) && !(ms & (1 << sIdx.get(l.slot)))) {
          if (l.capacity >= INF / 2) { infinite = true; break; }
          cut += l.capacity;
        }
      }
      if (!infinite && cut < best) best = cut;
    }
  }
  return best;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- acceptance 1: three orders, two machines, basic feasible ----------

test('acceptance 1: three orders, two machines, basic feasible flow', () => {
  const p = new Planner();
  run(p, [
    { cmd: 'add_slot', id: 's1', machine: 'm1', start: 0, end: 10, capacity: 10 },
    { cmd: 'add_slot', id: 's2', machine: 'm2', start: 0, end: 10, capacity: 8 },
    { cmd: 'add_order', id: 'o1', demand: 6, window: [0, 10] },
    { cmd: 'add_order', id: 'o2', demand: 5, window: [0, 10] },
    { cmd: 'add_order', id: 'o3', demand: 4, window: [0, 10] },
    { cmd: 'link', order: 'o1', slot: 's1' },
    { cmd: 'link', order: 'o1', slot: 's2' },
    { cmd: 'link', order: 'o2', slot: 's1' },
    { cmd: 'link', order: 'o2', slot: 's2' },
    { cmd: 'link', order: 'o3', slot: 's1' },
    { cmd: 'link', order: 'o3', slot: 's2' },
  ]);
  const r = p.execute({ cmd: 'flow' });
  assert.equal(r.value, 15); // total demand 15 <= total capacity 18
  // assignments sorted by order id, then start time
  const keys = r.assignments.map((a) => `${a.order}@${a.start}/${a.slot}`);
  assert.deepEqual(keys, [...keys].sort());
  const perOrder = new Map();
  for (const a of r.assignments) perOrder.set(a.order, (perOrder.get(a.order) ?? 0) + a.quantity);
  assert.equal(perOrder.get('o1'), 6);
  assert.equal(perOrder.get('o2'), 5);
  assert.equal(perOrder.get('o3'), 4);
  const v = p.execute({ cmd: 'verify' });
  assert.equal(v.ok, true);
  assert.deepEqual(v.checks, { capacity: true, conservation: true, time_window: true, cut_equality: true });
  assert.equal(v.cut_value, 15);
});

// ---------- acceptance 2: slowdown lowers value and migrates the bottleneck ----------

test('acceptance 2: slow(machine, factor) drops value and migrates bottleneck cut', () => {
  const p = new Planner();
  run(p, [
    { cmd: 'add_slot', id: 's1', machine: 'm1', start: 0, end: 10, capacity: 12 },
    { cmd: 'add_slot', id: 's2', machine: 'm2', start: 0, end: 10, capacity: 8 },
    { cmd: 'add_order', id: 'o1', demand: 10, window: [0, 10] },
    { cmd: 'add_order', id: 'o2', demand: 10, window: [0, 10] },
    { cmd: 'link', order: 'o1', slot: 's1' },
    { cmd: 'link', order: 'o1', slot: 's2' },
    { cmd: 'link', order: 'o2', slot: 's1' },
    { cmd: 'link', order: 'o2', slot: 's2' },
  ]);
  const before = p.execute({ cmd: 'flow' });
  assert.equal(before.value, 20); // demand-bound: bottleneck is the order side
  assert.deepEqual(before.bottleneck_cut.orders, ['o1', 'o2']);
  assert.deepEqual(before.bottleneck_cut.slots, []);

  ok(p, { cmd: 'slow', machine: 'm1', factor: 0.5 }); // s1 capacity 12 -> 6
  const after = p.execute({ cmd: 'flow' });
  assert.equal(after.value, 14); // 6 + 8
  assert.ok(after.value < before.value, 'value must decrease after slowdown');
  // bottleneck migrates from the order side to the machine slots
  assert.deepEqual(after.bottleneck_cut.orders, []);
  assert.deepEqual(after.bottleneck_cut.slots, ['s1', 's2']);
  assert.ok(after.bottleneck_cut.cut_edges.some((e) => e.from === 's1' && e.capacity === 6));
  assert.equal(after.bottleneck_cut.value, 14);
  assert.equal(p.execute({ cmd: 'verify' }).ok, true);
});

// ---------- acceptance 3: rush order then undo restores the original value ----------

test('acceptance 3: insert order, undo restores original value; commit protects state', () => {
  const p = new Planner();
  run(p, [
    { cmd: 'add_slot', id: 's1', machine: 'm1', start: 0, end: 10, capacity: 100 },
    { cmd: 'add_order', id: 'o1', demand: 10, window: [0, 10] },
    { cmd: 'add_order', id: 'o2', demand: 10, window: [0, 10] },
    { cmd: 'link', order: 'o1', slot: 's1' },
    { cmd: 'link', order: 'o2', slot: 's1' },
    { cmd: 'commit' },
  ]);
  const v1 = p.execute({ cmd: 'flow' }).value;
  assert.equal(v1, 20);

  // rush order insertion (three corrections: order + two links)
  run(p, [
    { cmd: 'add_order', id: 'o3', demand: 5, window: [0, 10] },
    { cmd: 'link', order: 'o3', slot: 's1' },
  ]);
  assert.equal(p.execute({ cmd: 'flow' }).value, 25);

  ok(p, { cmd: 'undo' }); // undo link
  ok(p, { cmd: 'undo' }); // undo add_order
  assert.equal(p.execute({ cmd: 'flow' }).value, v1, 'undo must restore the original value');

  // committed plan must survive any undo sequence
  expectError(p, { cmd: 'undo' }, 'UNDO_EMPTY');
  assert.equal(p.execute({ cmd: 'flow' }).value, 20);

  // cancel as a correction is undoable too
  ok(p, { cmd: 'cancel', id: 'o1' });
  assert.equal(p.execute({ cmd: 'flow' }).value, 10);
  ok(p, { cmd: 'undo' });
  assert.equal(p.execute({ cmd: 'flow' }).value, 20);
});

// ---------- acceptance 4: n <= 8 cross-checked against brute-force min cut ----------

test('acceptance 4: max-flow value matches brute-force cut enumeration (n<=8)', () => {
  const rnd = mulberry32(20261008);
  const ri = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

  for (let instance = 0; instance < 40; instance++) {
    const p = new Planner();
    const nOrders = ri(1, 8);
    const nSlots = ri(1, 8);
    const machines = ['m1', 'm2', 'm3'];
    const machineEnd = new Map(machines.map((m) => [m, 0]));

    const slotIds = [];
    for (let j = 0; j < nSlots; j++) {
      const machine = machines[ri(0, machines.length - 1)];
      const start = machineEnd.get(machine) + ri(0, 3);
      const end = start + ri(1, 5);
      machineEnd.set(machine, end);
      const id = `s${j}`;
      slotIds.push(id);
      ok(p, { cmd: 'add_slot', id, machine, start, end, capacity: ri(1, 8) });
    }
    const orderIds = [];
    for (let i = 0; i < nOrders; i++) {
      const id = `o${i}`;
      orderIds.push(id);
      ok(p, { cmd: 'add_order', id, demand: ri(1, 5), window: [0, 1000] });
    }
    for (const o of orderIds) {
      for (const s of slotIds) {
        if (rnd() < 0.5) {
          const link = { cmd: 'link', order: o, slot: s };
          if (rnd() < 0.3) link.capacity = ri(1, 5); // finite link capacity
          ok(p, link);
        }
      }
    }
    const usedMachines = [...new Set([...p.currentState().slots.values()].map((s) => s.machine))];
    if (rnd() < 0.5) ok(p, { cmd: 'slow', machine: usedMachines[ri(0, usedMachines.length - 1)], factor: 0.5 });

    const got = p.execute({ cmd: 'flow' }).value;
    const want = bruteForceMinCut(p.currentState());
    assert.ok(Math.abs(got - want) <= 1e-6, `instance ${instance}: flow ${got} != brute force ${want}`);
    assert.equal(p.execute({ cmd: 'verify' }).ok, true, `instance ${instance}: verify failed`);
  }
});

// ---------- acceptance 5: invalid inputs and commit conflicts ----------

test('acceptance 5: time-window overlap, negative capacity, duplicate commit errors', () => {
  const p = new Planner();
  run(p, [
    { cmd: 'add_slot', id: 's1', machine: 'm1', start: 0, end: 10, capacity: 5 },
    { cmd: 'add_order', id: 'o1', demand: 3, window: [20, 30] },
  ]);
  // link whose slot is disjoint from the order time window
  expectError(p, { cmd: 'link', order: 'o1', slot: 's1' }, 'INVALID_INPUT');
  // overlapping slot on the same machine
  expectError(p, { cmd: 'add_slot', id: 's2', machine: 'm1', start: 5, end: 15, capacity: 5 }, 'INVALID_INPUT');
  // negative capacities / demands
  expectError(p, { cmd: 'add_slot', id: 's3', machine: 'm2', start: 0, end: 5, capacity: -1 }, 'INVALID_INPUT');
  expectError(p, { cmd: 'add_order', id: 'o2', demand: -2, window: [0, 5] }, 'INVALID_INPUT');
  expectError(p, { cmd: 'add_order', id: 'o3', demand: 0, window: [0, 5] }, 'INVALID_INPUT');
  // bad slow factors / unknown machine
  expectError(p, { cmd: 'slow', machine: 'm1', factor: 0 }, 'INVALID_INPUT');
  expectError(p, { cmd: 'slow', machine: 'm1', factor: 1.5 }, 'INVALID_INPUT');
  expectError(p, { cmd: 'slow', machine: 'nope', factor: 0.5 }, 'INVALID_INPUT');
  // unknown references
  expectError(p, { cmd: 'link', order: 'ghost', slot: 's1' }, 'INVALID_INPUT');
  expectError(p, { cmd: 'cancel', id: 'ghost' }, 'INVALID_INPUT');
  expectError(p, { cmd: 'bogus' }, 'INVALID_INPUT');

  // duplicate commit: first commit succeeds (pending corrections exist), second conflicts
  ok(p, { cmd: 'add_slot', id: 's9', machine: 'm9', start: 0, end: 1, capacity: 1 });
  ok(p, { cmd: 'commit' });
  expectError(p, { cmd: 'commit' }, 'CONFLICT');
  // undo after commit must not touch the committed plan
  expectError(p, { cmd: 'undo' }, 'UNDO_EMPTY');
});

// ---------- CLI end-to-end ----------

test('CLI: JSONL in, JSONL out, including error codes', () => {
  const input = [
    JSON.stringify({ cmd: 'add_slot', id: 's1', machine: 'm1', start: 0, end: 10, capacity: 7 }),
    JSON.stringify({ cmd: 'add_order', id: 'o1', demand: 4, window: [0, 10] }),
    JSON.stringify({ cmd: 'link', order: 'o1', slot: 's1' }),
    JSON.stringify({ cmd: 'flow' }),
    JSON.stringify({ cmd: 'verify' }),
    JSON.stringify({ cmd: 'undo' }),
    JSON.stringify({ cmd: 'undo' }),
    JSON.stringify({ cmd: 'undo' }),
    JSON.stringify({ cmd: 'undo' }),
    JSON.stringify({ cmd: 'commit' }),
    'not json',
  ].join('\n');
  const out = processJsonl(input);

  assert.equal(out[3].value, 4);
  assert.deepEqual(out[3].assignments, [
    { order: 'o1', slot: 's1', machine: 'm1', start: 0, end: 10, quantity: 4 },
  ]);
  assert.equal(out[3].bottleneck_cut.value, 4);
  assert.equal(out[4].ok, true);
  assert.equal(out[5].ok, true); // undo link
  assert.equal(out[6].ok, true); // undo add_order
  assert.equal(out[7].ok, true); // undo add_slot
  assert.equal(out[8].error, 'UNDO_EMPTY');
  assert.equal(out[9].error, 'CONFLICT');
  assert.equal(out[10].error, 'INVALID_INPUT');
});

// ---------- scale sanity: 150 orders, 300 slots ----------

test('scale: 150 orders x 300 slots solves quickly and verifies', () => {
  const p = new Planner();
  const slots = [];
  for (let j = 0; j < 300; j++) {
    const machine = `m${j % 10}`;
    const start = Math.floor(j / 10) * 10;
    const id = `s${j}`;
    slots.push(id);
    ok(p, { cmd: 'add_slot', id, machine, start, end: start + 9, capacity: 20 });
  }
  for (let i = 0; i < 150; i++) {
    const id = `o${i}`;
    ok(p, { cmd: 'add_order', id, demand: 15, window: [0, 300] });
    for (let k = 0; k < 4; k++) ok(p, { cmd: 'link', order: id, slot: slots[(i * 7 + k * 73) % 300] });
  }
  const t0 = performance.now();
  const r = p.execute({ cmd: 'flow' });
  const elapsed = performance.now() - t0;
  assert.equal(r.value, 150 * 15); // demand-bound: 2250 <= 6000 capacity
  assert.equal(p.execute({ cmd: 'verify' }).ok, true);
  assert.ok(elapsed < 2000, `flow took ${elapsed}ms`);
});
