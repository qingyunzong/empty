import type { Problem } from "./model.js";
import { validate, workerChoices } from "./model.js";

/**
 * Independent exact checker for small instances: enumerates every priority
 * permutation of the jobs and evaluates the serial schedule-generation
 * scheme (each job placed at its earliest feasible slot). The optimum over
 * all permutations is the optimal makespan, because some permutation
 * reproduces every active schedule. Returns null if nothing fits the horizon.
 *
 * Feasible for n <= ~9 jobs (n! permutations); used to cross-check `solve`.
 */
export function bruteForceMakespan(problem: Problem): number | null {
  validate(problem);
  const { jobs, horizon } = problem;
  const n = jobs.length;
  const index = new Map(jobs.map((j, i) => [j.id, i]));
  const depIdx = jobs.map((j) => j.deps.map((d) => index.get(d)!));
  const choices = jobs.map((j) => workerChoices(j.skill));
  const cap = jobs.reduce((s, j) => s + j.duration, 0) + 1;

  let best = Infinity;
  const perm = [...Array(n).keys()];

  function evaluate(): void {
    const busy = [new Array<boolean>(cap).fill(false), new Array<boolean>(cap).fill(false)];
    const end = new Array<number>(n).fill(-1);
    const done = new Array<boolean>(n).fill(false);
    let makespan = 0;
    for (let stage = 0; stage < n; stage++) {
      // Serial SGS: among jobs whose predecessors are all scheduled,
      // pick the one that comes first in the priority permutation.
      let i = -1;
      for (const cand of perm) {
        if (!done[cand] && depIdx[cand].every((d) => done[d])) { i = cand; break; }
      }
      let t = 0;
      for (const d of depIdx[i]) t = Math.max(t, end[d]);
      const dur = jobs[i].duration;
      let start = Infinity;
      let assigned: number[] = [];
      for (const ws of choices[i]) {
        let s = t;
        scan: for (; s + dur <= cap; s++) {
          for (const w of ws) {
            for (let k = s; k < s + dur; k++) if (busy[w][k]) continue scan;
          }
          break;
        }
        if (s < start) { start = s; assigned = ws; }
      }
      for (const w of assigned) for (let k = start; k < start + dur; k++) busy[w][k] = true;
      end[i] = start + dur;
      done[i] = true;
      makespan = Math.max(makespan, end[i]);
      if (makespan >= best) return; // cannot improve
    }
    if (makespan < best) best = makespan;
  }

  // Heap's algorithm, iterative.
  evaluate();
  const c = new Array<number>(n).fill(0);
  let i = 0;
  while (i < n) {
    if (c[i] < i) {
      const j = i % 2 === 0 ? 0 : c[i];
      [perm[j], perm[i]] = [perm[i], perm[j]];
      evaluate();
      c[i]++;
      i = 0;
    } else {
      c[i] = 0;
      i++;
    }
  }
  return best <= horizon ? best : null;
}
