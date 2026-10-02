const CAP = 3000000;

export function optimize(base) {
  const ops = base.ops.map((o) => ({ ...o, preds: o.preds || [] }));
  const n = ops.length;
  const idx = new Map(ops.map((o, i) => [o.id, i]));
  const predIdx = ops.map((o) => o.preds.map((p) => idx.get(p)));
  const domains = ops.map((o) => (o.machines && o.machines.length ? o.machines : [o.machine]));
  let best = { cost: Infinity, schedule: null };
  let leaves = 0;
  const assign = new Array(n);
  const order = [];
  const done = new Array(n).fill(false);
  function scheduleCost() {
    const free = {};
    const end = new Array(n);
    for (const i of order) {
      const m = assign[i];
      let s = free[m] || 0;
      for (const p of predIdx[i]) s = Math.max(s, end[p]);
      end[i] = s + ops[i].dur;
      free[m] = end[i];
    }
    const jobEnd = {};
    for (let i = 0; i < n; i++) {
      const j = ops[i].job;
      jobEnd[j] = Math.max(jobEnd[j] || 0, end[i]);
    }
    let pen = 0;
    for (const j of base.jobs) {
      const e = jobEnd[j.id] || 0;
      const d = j.due ?? Infinity;
      if (e > d) pen += (j.weight ?? 1) * (e - d);
    }
    return { pen, end };
  }
  function enumOrders() {
    if (order.length === n) {
      if (++leaves > CAP) throw new Error('search space too large for exact optimize');
      const { pen, end } = scheduleCost();
      if (pen < best.cost) {
        best = {
          cost: pen,
          schedule: ops.map((o, i) => ({ ...o, machine: assign[i], start: end[i] - o.dur })),
        };
      }
      return;
    }
    for (let i = 0; i < n; i++) {
      if (done[i]) continue;
      let ready = true;
      for (const p of predIdx[i]) if (!done[p]) { ready = false; break; }
      if (!ready) continue;
      done[i] = true;
      order.push(i);
      enumOrders();
      order.pop();
      done[i] = false;
    }
  }
  function enumAssign(k) {
    if (k === n) { enumOrders(); return; }
    for (const m of domains[k]) { assign[k] = m; enumAssign(k + 1); }
  }
  enumAssign(0);
  return best;
}
