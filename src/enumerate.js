import { opTable } from './model.js';

export function enumerateOptimal(plan, dyn) {
  const ops = opTable(plan, dyn);
  const ids = [...ops.keys()];
  const n = ids.length;
  if (n > 12) throw new Error(`enumerator limited to n<=12, got ${n}`);
  const idx = new Map(ids.map((id, i) => [id, i]));
  const machines = plan.machines.map((m) => ({ id: m.id, caps: new Set(m.caps) }));
  const pred = ids.map((id) => {
    const p = ops.get(id).pred;
    return p ? idx.get(p) : -1;
  });
  const jobIdx = ids.map((id) => plan.jobs.findIndex((j) => j.id === ops.get(id).job));
  const dur = ids.map((id) => ops.get(id).dur);
  const cap = ids.map((id) => ops.get(id).cap);
  const weights = plan.jobs.map((j) => j.weight ?? 1);
  const dues = plan.jobs.map((j) => j.due);
  const machineFree = new Array(machines.length).fill(0);
  const end = new Array(n).fill(-1);
  const jobEnd = new Array(plan.jobs.length).fill(0);
  const lists = machines.map(() => []);
  let best = { cost: Infinity, order: null };
  function lowerBound() {
    let lb = 0;
    for (let j = 0; j < plan.jobs.length; j++) lb += weights[j] * Math.max(0, jobEnd[j] - dues[j]);
    return lb;
  }
  function dfs(done) {
    if (lowerBound() >= best.cost) return;
    if (done === n) {
      best = { cost: lowerBound(), order: lists.map((l) => [...l]) };
      return;
    }
    for (let i = 0; i < n; i++) {
      if (end[i] >= 0) continue;
      if (pred[i] >= 0 && end[pred[i]] < 0) continue;
      for (let m = 0; m < machines.length; m++) {
        if (!machines[m].caps.has(cap[i])) continue;
        const s = Math.max(machineFree[m], pred[i] >= 0 ? end[pred[i]] : 0);
        const e = s + dur[i];
        const j = jobIdx[i];
        const prevMf = machineFree[m], prevJobEnd = jobEnd[j];
        end[i] = e; machineFree[m] = e; jobEnd[j] = Math.max(jobEnd[j], e);
        lists[m].push(ids[i]);
        dfs(done + 1);
        lists[m].pop();
        end[i] = -1; machineFree[m] = prevMf; jobEnd[j] = prevJobEnd;
      }
    }
  }
  dfs(0);
  const order = {};
  machines.forEach((m, i) => { order[m.id] = best.order ? best.order[i] : []; });
  return { cost: best.cost, order };
}
