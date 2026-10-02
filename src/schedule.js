import { SchedError } from './errors.js';

export function setupTime(state, machine, fromFamily, toFamily) {
  if (fromFamily === null || fromFamily === toFamily) return 0;
  return state.setup[machine]?.[fromFamily]?.[toFamily] ?? 0;
}

export function collectOps(state) {
  const ops = [];
  for (const orderId of Object.keys(state.orders).sort()) {
    const order = state.orders[orderId];
    for (const op of order.ops ?? []) {
      ops.push({
        id: op.id,
        orderId,
        machine: op.machine,
        duration: op.duration,
        family: op.family ?? null,
        preds: op.preds ?? [],
        priority: order.priority ?? 1,
      });
    }
  }
  return ops;
}

export function validatePrecedence(ops) {
  const ids = new Set(ops.map((o) => o.id));
  if (ids.size !== ops.length) {
    throw new SchedError('E_PRECEDENCE', 'duplicate operation id across orders');
  }
  const succ = new Map([...ids].map((id) => [id, []]));
  const indeg = new Map([...ids].map((id) => [id, 0]));
  for (const o of ops) {
    for (const p of o.preds) {
      if (!ids.has(p)) {
        throw new SchedError('E_PRECEDENCE', `operation ${o.id} depends on unknown operation ${p}`);
      }
      succ.get(p).push(o.id);
      indeg.set(o.id, indeg.get(o.id) + 1);
    }
  }
  const queue = [...ids].filter((id) => indeg.get(id) === 0);
  let seen = 0;
  while (queue.length) {
    const x = queue.pop();
    seen++;
    for (const y of succ.get(x)) {
      indeg.set(y, indeg.get(y) - 1);
      if (indeg.get(y) === 0) queue.push(y);
    }
  }
  if (seen !== ids.size) {
    throw new SchedError('E_PRECEDENCE', 'cyclic precedence constraint');
  }
}

export function lexCompare(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

export function betterSolution(a, b) {
  if (b === null) return true;
  if (a.objective !== b.objective) return a.objective < b.objective;
  if (a.totalSetup !== b.totalSetup) return a.totalSetup < b.totalSetup;
  return lexCompare(a.sequence, b.sequence) < 0;
}

function placeOp(op, ctx, calendars, state) {
  const cal = calendars[op.machine];
  const prev = ctx.last[op.machine] ?? { end: 0, family: null };
  const setup = prev.family === null ? 0 : setupTime(state, op.machine, prev.family, op.family);
  let ready = prev.end;
  for (const p of op.preds) ready = Math.max(ready, ctx.endOf[p]);
  for (const [ws, we] of cal) {
    const s = Math.max(ws, ready);
    if (s + setup + op.duration <= we) {
      return { setupStart: s, setup, start: s + setup, end: s + setup + op.duration };
    }
  }
  return null;
}

// Exact scheduler: enumerates linear extensions of the precedence DAG with
// branch and bound. Primary objective: total weighted completion time
// (sum of order priority * order completion). Ties are broken by total
// changeover time, then by the lexicographic work-order sequence
// (per-machine order-id lists, machines in sorted id order, concatenated).
export function computeSchedule(state, opts = {}) {
  const ops = collectOps(state);
  const opMap = new Map(ops.map((o) => [o.id, o]));
  const calendars = {};
  for (const [id, m] of Object.entries(state.machines)) {
    calendars[id] = [...m.calendar].sort((a, b) => a[0] - b[0]);
  }
  for (const o of ops) {
    if (!calendars[o.machine]) {
      throw new SchedError('E_STATE', `unknown machine ${o.machine}`);
    }
  }
  validatePrecedence(ops);

  const orderOpCount = {};
  for (const o of ops) orderOpCount[o.orderId] = (orderOpCount[o.orderId] ?? 0) + 1;
  const indeg = new Map(ops.map((o) => [o.id, o.preds.length]));
  const succ = new Map(ops.map((o) => [o.id, []]));
  for (const o of ops) for (const p of o.preds) succ.get(p).push(o.id);

  const ctx = {
    last: {},
    endOf: {},
    totalSetup: 0,
    objective: 0,
    orderEnd: {},
    doneOps: {},
    seqByMachine: {},
    assignments: [],
  };
  let best = null;

  function snapshotSolution() {
    const sequence = Object.keys(ctx.seqByMachine)
      .sort()
      .flatMap((m) => ctx.seqByMachine[m]);
    return {
      objective: ctx.objective,
      totalSetup: ctx.totalSetup,
      makespan: Math.max(0, ...Object.values(ctx.endOf)),
      sequence,
      assignments: ctx.assignments.map((a) => ({ ...a })),
    };
  }

  function dfs(available) {
    if (available.length === 0) {
      const sol = snapshotSolution();
      if (betterSolution(sol, best)) best = sol;
      return;
    }
    for (const id of [...available].sort()) {
      const op = opMap.get(id);
      const pl = placeOp(op, ctx, calendars, state);
      if (!pl) continue;

      const prevLast = ctx.last[op.machine] ?? null;
      const prevOrderEnd = ctx.orderEnd[op.orderId] ?? null;
      ctx.last[op.machine] = { end: pl.end, family: op.family };
      ctx.endOf[op.id] = pl.end;
      ctx.totalSetup += pl.setup;
      (ctx.seqByMachine[op.machine] ??= []).push(op.orderId);
      ctx.assignments.push({
        op: op.id,
        order: op.orderId,
        machine: op.machine,
        setupStart: pl.setupStart,
        start: pl.start,
        end: pl.end,
      });
      ctx.doneOps[op.orderId] = (ctx.doneOps[op.orderId] ?? 0) + 1;
      ctx.orderEnd[op.orderId] = Math.max(prevOrderEnd ?? 0, pl.end);
      let added = 0;
      if (ctx.doneOps[op.orderId] === orderOpCount[op.orderId]) {
        added = op.priority * ctx.orderEnd[op.orderId];
      }
      ctx.objective += added;

      const next = available.filter((x) => x !== id);
      for (const s of succ.get(id)) {
        indeg.set(s, indeg.get(s) - 1);
        if (indeg.get(s) === 0) next.push(s);
      }

      const pruned =
        best !== null &&
        (ctx.objective > best.objective ||
          (ctx.objective === best.objective && ctx.totalSetup > best.totalSetup));
      if (!pruned) dfs(next);

      for (const s of succ.get(id)) indeg.set(s, indeg.get(s) + 1);
      ctx.objective -= added;
      if (prevOrderEnd === null) delete ctx.orderEnd[op.orderId];
      else ctx.orderEnd[op.orderId] = prevOrderEnd;
      ctx.doneOps[op.orderId] -= 1;
      ctx.assignments.pop();
      ctx.seqByMachine[op.machine].pop();
      if (ctx.seqByMachine[op.machine].length === 0) delete ctx.seqByMachine[op.machine];
      ctx.totalSetup -= pl.setup;
      delete ctx.endOf[op.id];
      if (prevLast === null) delete ctx.last[op.machine];
      else ctx.last[op.machine] = prevLast;
    }
  }

  dfs(ops.filter((o) => o.preds.length === 0).map((o) => o.id));

  if (best === null) {
    throw new SchedError('E_BUDGET', 'no feasible schedule within machine calendars');
  }
  if (opts.budget !== undefined && opts.budget !== null && best.makespan > opts.budget) {
    throw new SchedError('E_BUDGET', `makespan ${best.makespan} exceeds budget ${opts.budget}`);
  }
  return best;
}
