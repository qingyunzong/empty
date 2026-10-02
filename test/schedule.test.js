import test from 'node:test';
import assert from 'node:assert/strict';
import { computeSchedule } from '../src/schedule.js';

const state = {
  machines: {
    M1: { id: 'M1', calendar: [[0, 40]] },
    M2: { id: 'M2', calendar: [[0, 40]] },
  },
  orders: {
    W1: {
      id: 'W1',
      priority: 3,
      ops: [
        { id: 'a1', machine: 'M1', duration: 4, family: 'A', preds: [] },
        { id: 'a2', machine: 'M2', duration: 3, family: 'B', preds: ['a1'] },
      ],
    },
    W2: {
      id: 'W2',
      priority: 1,
      ops: [
        { id: 'b1', machine: 'M1', duration: 2, family: 'B', preds: [] },
        { id: 'b2', machine: 'M2', duration: 5, family: 'A', preds: ['b1'] },
      ],
    },
    W3: {
      id: 'W3',
      priority: 2,
      ops: [
        { id: 'c1', machine: 'M2', duration: 3, family: 'A', preds: [] },
        { id: 'c2', machine: 'M1', duration: 2, family: 'C', preds: ['c1'] },
      ],
    },
  },
  setup: {
    M1: { A: { B: 2, C: 1 }, B: { A: 3 }, C: { A: 1 } },
    M2: { A: { B: 1 }, B: { A: 2 } },
  },
  schedule: null,
};

// --- independent brute-force reference -------------------------------------

function permutations(items) {
  if (items.length <= 1) return [items.slice()];
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const rest = items.slice(0, i).concat(items.slice(i + 1));
    for (const p of permutations(rest)) out.push([items[i], ...p]);
  }
  return out;
}

function refSetup(st, machine, from, to) {
  if (from === null || from === to) return 0;
  return st.setup[machine]?.[from]?.[to] ?? 0;
}

function refSimulate(st, perm) {
  const endOf = {};
  const machineEnd = {};
  const machineFamily = {};
  const seqByMachine = {};
  let totalSetup = 0;
  const orderEnd = {};
  for (const op of perm) {
    let ready = machineEnd[op.machine] ?? 0;
    for (const p of op.preds ?? []) ready = Math.max(ready, endOf[p]);
    const setup = refSetup(st, op.machine, machineFamily[op.machine] ?? null, op.family ?? null);
    const cal = [...st.machines[op.machine].calendar].sort((a, b) => a[0] - b[0]);
    let placed = null;
    for (const [ws, we] of cal) {
      const s = Math.max(ws, ready);
      if (s + setup + op.duration <= we) {
        placed = s;
        break;
      }
    }
    if (placed === null) return null;
    const end = placed + setup + op.duration;
    endOf[op.id] = end;
    machineEnd[op.machine] = end;
    machineFamily[op.machine] = op.family ?? null;
    (seqByMachine[op.machine] ??= []).push(op.orderId);
    totalSetup += setup;
    orderEnd[op.orderId] = Math.max(orderEnd[op.orderId] ?? 0, end);
  }
  let objective = 0;
  for (const [orderId, order] of Object.entries(st.orders)) {
    objective += (order.priority ?? 1) * (orderEnd[orderId] ?? 0);
  }
  const sequence = Object.keys(seqByMachine)
    .sort()
    .flatMap((m) => seqByMachine[m]);
  return { objective, totalSetup, makespan: Math.max(...Object.values(endOf)), sequence };
}

function refLex(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return a.length - b.length;
}

function referenceOptimal(st) {
  const ops = [];
  for (const [orderId, order] of Object.entries(st.orders)) {
    for (const op of order.ops) ops.push({ ...op, orderId });
  }
  let best = null;
  for (const perm of permutations(ops)) {
    const pos = new Map(perm.map((o, i) => [o.id, i]));
    if (perm.some((o) => (o.preds ?? []).some((p) => pos.get(p) > pos.get(o.id)))) continue;
    const sol = refSimulate(st, perm);
    if (!sol) continue;
    if (
      !best ||
      sol.objective < best.objective ||
      (sol.objective === best.objective && sol.totalSetup < best.totalSetup) ||
      (sol.objective === best.objective &&
        sol.totalSetup === best.totalSetup &&
        refLex(sol.sequence, best.sequence) < 0)
    ) {
      best = sol;
    }
  }
  return best;
}

// --- tests -------------------------------------------------------------------

test('matches brute-force enumeration of all permutations', () => {
  const best = computeSchedule(state);
  const ref = referenceOptimal(state);
  assert.equal(best.objective, ref.objective);
  assert.equal(best.totalSetup, ref.totalSetup);
  assert.equal(best.makespan, ref.makespan);
  assert.deepEqual(best.sequence, ref.sequence);
});

test('respects precedence and machine load constraints', () => {
  const best = computeSchedule(state);
  const byOp = new Map(best.assignments.map((a) => [a.op, a]));
  for (const order of Object.values(state.orders)) {
    for (const op of order.ops) {
      for (const p of op.preds) {
        assert.ok(byOp.get(p).end <= byOp.get(op.id).start, `${p} must finish before ${op.id}`);
      }
    }
  }
  const byMachine = {};
  for (const a of best.assignments) (byMachine[a.machine] ??= []).push(a);
  for (const [m, list] of Object.entries(byMachine)) {
    list.sort((x, y) => x.setupStart - y.setupStart);
    for (let i = 1; i < list.length; i++) {
      assert.ok(list[i - 1].end <= list[i].setupStart, `overlap on machine ${m}`);
    }
    for (const a of list) {
      const fits = state.machines[m].calendar.some(([ws, we]) => a.setupStart >= ws && a.end <= we);
      assert.ok(fits, `op ${a.op} outside calendar of ${m}`);
    }
  }
});

test('changeover time is minimized among co-optimal solutions', () => {
  const best = computeSchedule(state);
  const ref = referenceOptimal(state);
  const coOptimal = [];
  const ops = [];
  for (const [orderId, order] of Object.entries(state.orders)) {
    for (const op of order.ops) ops.push({ ...op, orderId });
  }
  for (const perm of permutations(ops)) {
    const pos = new Map(perm.map((o, i) => [o.id, i]));
    if (perm.some((o) => (o.preds ?? []).some((p) => pos.get(p) > pos.get(o.id)))) continue;
    const sol = refSimulate(state, perm);
    if (sol && sol.objective === ref.objective) coOptimal.push(sol.totalSetup);
  }
  assert.equal(best.totalSetup, Math.min(...coOptimal));
});

test('E_BUDGET when deadline below optimal makespan', () => {
  const best = computeSchedule(state);
  assert.throws(() => computeSchedule(state, { budget: best.makespan - 1 }), { code: 'E_BUDGET' });
  const ok = computeSchedule(state, { budget: best.makespan });
  assert.equal(ok.makespan, best.makespan);
});

test('E_PRECEDENCE on cyclic or dangling precedence', () => {
  const cyclic = {
    ...state,
    orders: {
      X1: {
        id: 'X1',
        priority: 1,
        ops: [
          { id: 'p', machine: 'M1', duration: 1, family: 'A', preds: ['q'] },
          { id: 'q', machine: 'M1', duration: 1, family: 'A', preds: ['p'] },
        ],
      },
    },
  };
  assert.throws(() => computeSchedule(cyclic), { code: 'E_PRECEDENCE' });
  const dangling = {
    ...state,
    orders: {
      X2: {
        id: 'X2',
        priority: 1,
        ops: [{ id: 'p', machine: 'M1', duration: 1, family: 'A', preds: ['nope'] }],
      },
    },
  };
  assert.throws(() => computeSchedule(dangling), { code: 'E_PRECEDENCE' });
});
