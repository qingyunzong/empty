import { normalizeSpec } from "./spec.js";
import { comparePlans } from "./solver.js";

export function bruteForce(rawSpec, opts = {}) {
  const norm = normalizeSpec(rawSpec);
  const nodeCap = opts.nodeCap ?? 50_000_000;
  const n = norm.steps.length;
  const M = norm.machines;
  const L = norm.memoryLimit;
  const dur = norm.steps.map((s) => s.duration);
  const mem = norm.steps.map((s) => s.memory);
  const ids = norm.steps.map((s) => s.id);

  for (let i = 0; i < n; i++) {
    if (mem[i] > L) return { status: "UNSAT" };
  }

  const compatOk = (uIdx, pu, vIdx, pv) => norm.compat.get(ids[uIdx] + ">" + ids[vIdx]).get(pu).includes(pv);
  const overlap = (s1, d1, s2, d2) => s1 < s2 + d2 && s2 < s1 + d1;
  const lb = Math.max(norm.critPath, Math.ceil(norm.totalDur / M));
  const ub = norm.totalDur;
  let nodes = 0;

  {
    const doms = norm.steps.map((s) => [...s.params]);
    let wiped = false;
    let changed = true;
    while (changed && !wiped) {
      changed = false;
      for (const [uu, vv] of norm.edges) {
        const u = norm.index.get(uu);
        const v = norm.index.get(vv);
        for (const dir of [0, 1]) {
          const x = dir === 0 ? u : v;
          const y = dir === 0 ? v : u;
          const kept = doms[x].filter((px) => doms[y].some((py) => (dir === 0 ? compatOk(x, px, y, py) : compatOk(y, py, x, px))));
          if (kept.length === 0) {
            wiped = true;
            break;
          }
          if (kept.length < doms[x].length) {
            doms[x] = kept;
            changed = true;
          }
        }
      }
    }
    if (wiped) return { status: "UNSAT", nodes };
  }

  for (let T = lb; T <= ub; T++) {
    const assigned = new Array(n).fill(null);
    const memUsed = new Array(T).fill(0);
    const machUsed = Array.from({ length: M }, () => new Array(T).fill(false));
    let best = null;
    let bestEnc = null;

    const tupleOf = (plan, i) => [plan[ids[i]].start, plan[ids[i]].machine, plan[ids[i]].param];

    const prefixBeatsBest = (j) => {
      for (let i = 0; i <= j; i++) {
        const a = assigned[i];
        const b = bestEnc[i];
        if (a.start !== b[0]) return a.start > b[0];
        if (a.machine !== b[1]) return a.machine > b[1];
        if (a.param !== b[2]) return a.param > b[2];
      }
      return false;
    };

    const fits = (j, start, m, p) => {
      for (const v of norm.succ[j]) {
        if (assigned[v] && start + dur[j] > assigned[v].start) return false;
        if (assigned[v] && !compatOk(j, p, v, assigned[v].param)) return false;
      }
      for (const u of norm.pred[j]) {
        if (assigned[u] && assigned[u].start + dur[u] > start) return false;
        if (assigned[u] && !compatOk(u, assigned[u].param, j, p)) return false;
      }
      for (const [a, b] of norm.mutex) {
        const other = a === j ? b : b === j ? a : -1;
        if (other >= 0 && assigned[other] && overlap(start, dur[j], assigned[other].start, dur[other])) return false;
      }
      for (let t = start; t < start + dur[j]; t++) {
        if (machUsed[m][t]) return false;
        if (memUsed[t] + mem[j] > L) return false;
      }
      return true;
    };

    const dfs = (j) => {
      if (j === n) {
        const plan = {};
        for (let i = 0; i < n; i++) plan[ids[i]] = { ...assigned[i] };
        if (best === null || comparePlans(plan, best) < 0) {
          best = plan;
          bestEnc = [];
          for (let i = 0; i < n; i++) bestEnc.push(tupleOf(plan, i));
        }
        return;
      }
      if (best !== null && prefixBeatsBest(j - 1)) return;
      let est = 0;
      for (const u of norm.pred[j]) if (assigned[u]) est = Math.max(est, assigned[u].start + dur[u]);
      let lst = T - dur[j];
      for (const v of norm.succ[j]) if (assigned[v]) lst = Math.min(lst, assigned[v].start - dur[j]);
      for (let start = est; start <= lst; start++) {
        for (let m = 0; m < M; m++) {
          for (const p of norm.steps[j].params) {
            if (++nodes > nodeCap) throw new Error("brute-force node cap exceeded");
            if (!fits(j, start, m, p)) continue;
            assigned[j] = { start, machine: m, param: p };
            for (let t = start; t < start + dur[j]; t++) {
              machUsed[m][t] = true;
              memUsed[t] += mem[j];
            }
            dfs(j + 1);
            for (let t = start; t < start + dur[j]; t++) {
              machUsed[m][t] = false;
              memUsed[t] -= mem[j];
            }
            assigned[j] = null;
          }
        }
      }
    };

    dfs(0);
    if (best !== null) return { status: "SAT", makespan: T, plan: best, nodes };
  }
  return { status: "UNSAT", nodes };
}
