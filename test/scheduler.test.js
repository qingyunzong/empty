import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solveSchedule } from '../src/scheduler.js';
import { emptyState } from '../src/state.js';

// ---- Independent reference: enumerate every permutation of operations ----

function refFit(calendar, earliest, duration) {
  for (const [ws, we] of calendar) {
    const s = Math.max(earliest, ws);
    if (s + duration <= we) return s;
  }
  return null;
}

function refSimulate(state, perm) {
  const free = {};
  const prod = {};
  const end = {};
  const comp = {};
  const seqMap = {};
  let coTotal = 0;
  for (const id of perm) {
    const [oid, idxStr] = id.split(':');
    const idx = Number(idxStr);
    const order = state.orders[oid];
    const op = order.ops[idx];
    let e = 0;
    if (idx > 0) e = end[`${oid}:${idx - 1}`];
    for (const p of state.deps[id] ?? []) e = Math.max(e, end[p]);
    const m = op.machine;
    let co = 0;
    if (prod[m] !== undefined && prod[m] !== order.product) {
      co = state.changeovers[m]?.[`${prod[m]}>${order.product}`] ?? 0;
    }
    e = Math.max(e, (free[m] ?? 0) + co);
    const start = refFit(state.machines[m].calendar, e, op.duration);
    if (start === null) return null;
    end[id] = start + op.duration;
    free[m] = end[id];
    prod[m] = order.product;
    (seqMap[m] ??= []).push(oid);
    comp[oid] = Math.max(comp[oid] ?? 0, end[id]);
    coTotal += co;
  }
  let objective = 0;
  for (const [oid, o] of Object.entries(state.orders)) objective += o.priority * comp[oid];
  const sequence = Object.keys(seqMap).sort().flatMap((m) => seqMap[m]);
  return { objective, changeover: coTotal, sequence };
}

function refCompare(a, b) {
  if (a.objective !== b.objective) return a.objective - b.objective;
  if (a.changeover !== b.changeover) return a.changeover - b.changeover;
  for (let i = 0; i < a.sequence.length; i++) {
    if (a.sequence[i] !== b.sequence[i]) return a.sequence[i] < b.sequence[i] ? -1 : 1;
  }
  return 0;
}

function* permutations(items) {
  if (items.length <= 1) {
    yield items.slice();
    return;
  }
  for (let i = 0; i < items.length; i++) {
    const rest = items.slice(0, i).concat(items.slice(i + 1));
    for (const p of permutations(rest)) yield [items[i], ...p];
  }
}

function refSolve(state) {
  const ops = [];
  for (const [oid, o] of Object.entries(state.orders)) {
    o.ops.forEach((_, i) => ops.push(`${oid}:${i}`));
  }
  let best = null;
  for (const perm of permutations(ops)) {
    const pos = new Map(perm.map((id, i) => [id, i]));
    let valid = true;
    for (const [oid, o] of Object.entries(state.orders)) {
      for (let i = 1; i < o.ops.length; i++) {
        if (pos.get(`${oid}:${i - 1}`) > pos.get(`${oid}:${i}`)) valid = false;
      }
    }
    for (const [id, ps] of Object.entries(state.deps)) {
      for (const p of ps) if (pos.get(p) > pos.get(id)) valid = false;
    }
    if (!valid) continue;
    const sol = refSimulate(state, perm);
    if (sol && (best === null || refCompare(sol, best) < 0)) best = sol;
  }
  return best;
}

function makeState() {
  const s = emptyState();
  s.machines.M1 = { id: 'M1', calendar: [[0, 240], [480, 960]] };
  s.machines.M2 = { id: 'M2', calendar: [[0, 1000]] };
  s.orders.W1 = { id: 'W1', product: 'P1', priority: 3, ops: [{ machine: 'M1', duration: 60 }, { machine: 'M2', duration: 30 }] };
  s.orders.W2 = { id: 'W2', product: 'P2', priority: 1, ops: [{ machine: 'M1', duration: 45 }, { machine: 'M2', duration: 60 }] };
  s.orders.W3 = { id: 'W3', product: 'P1', priority: 2, ops: [{ machine: 'M2', duration: 50 }] };
  s.changeovers.M1 = { 'P1>P2': 15, 'P2>P1': 10 };
  s.changeovers.M2 = { 'P1>P2': 5, 'P2>P1': 5 };
  return s;
}

test('library solver matches brute-force permutation reference', () => {
  const state = makeState();
  const expected = refSolve(state);
  const actual = solveSchedule(state);
  assert.equal(actual.objective, expected.objective);
  assert.equal(actual.changeover, expected.changeover);
  assert.deepEqual(actual.sequence, expected.sequence);
});

test('solver matches reference with explicit cross-order dependencies', () => {
  const state = makeState();
  state.deps = { 'W3:0': ['W1:0'] }; // W3 may start only after W1 op 0
  const expected = refSolve(state);
  const actual = solveSchedule(state);
  assert.equal(actual.objective, expected.objective);
  assert.equal(actual.changeover, expected.changeover);
  assert.deepEqual(actual.sequence, expected.sequence);
  assert.ok(actual.assignments['W3:0'].start >= actual.assignments['W1:0'].end);
});

test('solver matches reference on single-op orders across 3 machines', () => {
  const s = emptyState();
  for (const m of ['A', 'B', 'C']) s.machines[m] = { id: m, calendar: [[0, 500]] };
  s.orders.O1 = { id: 'O1', product: 'X', priority: 4, ops: [{ machine: 'A', duration: 30 }] };
  s.orders.O2 = { id: 'O2', product: 'Y', priority: 3, ops: [{ machine: 'A', duration: 20 }] };
  s.orders.O3 = { id: 'O3', product: 'X', priority: 2, ops: [{ machine: 'A', duration: 25 }] };
  s.orders.O4 = { id: 'O4', product: 'Y', priority: 1, ops: [{ machine: 'B', duration: 40 }] };
  s.changeovers.A = { 'X>Y': 12, 'Y>X': 8 };
  const expected = refSolve(s);
  const actual = solveSchedule(s);
  assert.equal(actual.objective, expected.objective);
  assert.equal(actual.changeover, expected.changeover);
  assert.deepEqual(actual.sequence, expected.sequence);
});

test('tie-break: minimal changeover then lexicographic order sequence', () => {
  // Two orders, same machine, symmetric durations: objective ties; the
  // changeover-minimizing / lexicographically smaller sequence must win.
  const s = emptyState();
  s.machines.M = { id: 'M', calendar: [[0, 1000]] };
  s.orders.WA = { id: 'WA', product: 'P', priority: 1, ops: [{ machine: 'M', duration: 10 }] };
  s.orders.WB = { id: 'WB', product: 'P', priority: 1, ops: [{ machine: 'M', duration: 10 }] };
  const sol = solveSchedule(s);
  assert.equal(sol.changeover, 0);
  assert.deepEqual(sol.sequence, ['WA', 'WB']);
});

test('calendar gaps are respected (machine load feasibility)', () => {
  const s = emptyState();
  s.machines.M = { id: 'M', calendar: [[0, 30], [100, 200]] };
  s.orders.W1 = { id: 'W1', product: 'P', priority: 1, ops: [{ machine: 'M', duration: 50 }] };
  const sol = solveSchedule(s);
  assert.equal(sol.assignments['W1:0'].start, 100); // does not fit in [0,30)
});
