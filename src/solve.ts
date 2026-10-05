import type { Problem } from "./model.js";
import { validate, workerChoices } from "./model.js";
import type { ScheduledJob, Solution } from "./schedule.js";

interface Running {
  idx: number;
  end: number;
  workers: number[];
}

interface Ctx {
  n: number;
  horizon: number;
  dur: number[];
  width: number[]; // 2 for "both" jobs, 1 otherwise (worker-time per slot)
  depMask: number[];
  tail: number[]; // longest precedence chain starting at j, including j
  fullMask: number;
}

function buildCtx(problem: Problem): Ctx {
  const { jobs } = problem;
  const n = jobs.length;
  const index = new Map(jobs.map((j, i) => [j.id, i]));
  const depMask = jobs.map((j) => j.deps.reduce((m, d) => m | (1 << index.get(d)!), 0));
  const succ: number[][] = jobs.map(() => []);
  jobs.forEach((j, i) => j.deps.forEach((d) => succ[index.get(d)!].push(i)));
  // tail[j] = dur[j] + max(tail[s] for s in succ[j]); jobs are processed in
  // reverse topological order (deps have no path back, graph is acyclic).
  const tail = new Array<number>(n).fill(0);
  const order: number[] = [];
  const state = new Array<number>(n).fill(0);
  const dfsTopo = (i: number): void => {
    if (state[i]) return;
    state[i] = 1;
    for (const s of succ[i]) dfsTopo(s);
    state[i] = 2;
    order.push(i);
  };
  for (let i = 0; i < n; i++) dfsTopo(i);
  for (const i of order) {
    tail[i] = jobs[i].duration + Math.max(0, ...succ[i].map((s) => tail[s]));
  }
  return {
    n,
    horizon: problem.horizon,
    dur: jobs.map((j) => j.duration),
    width: jobs.map((j) => (j.skill === "both" ? 2 : 1)),
    depMask,
    tail,
    fullMask: (1 << n) - 1,
  };
}

/** Greedy serial-SGS pass (critical-path priority) to seed the upper bound. */
function greedy(problem: Problem, ctx: Ctx): number {
  const { n, dur } = ctx;
  const order = [...Array(n).keys()].sort((a, b) => ctx.tail[b] - ctx.tail[a]);
  const cap = dur.reduce((a, b) => a + b, 0) + 1;
  const busy = [new Array<boolean>(cap).fill(false), new Array<boolean>(cap).fill(false)];
  const end = new Array<number>(n).fill(-1);
  const index = new Map(problem.jobs.map((j, i) => [j.id, i]));
  for (const i of order) {
    const job = problem.jobs[i];
    let t = Math.max(0, ...job.deps.map((d) => end[index.get(d)!]));
    const choices = workerChoices(job.skill);
    let bestT = Infinity;
    let bestW: number[] = [];
    for (const ws of choices) {
      let s = t;
      for (; s + dur[i] <= cap; s++) {
        if (ws.every((w) => busy[w].slice(s, s + dur[i]).every((b) => !b))) break;
      }
      if (s < bestT) { bestT = s; bestW = ws; }
    }
    for (const w of bestW) for (let k = bestT; k < bestT + dur[i]; k++) busy[w][k] = true;
    end[i] = bestT + dur[i];
  }
  return Math.max(...end);
}

/**
 * Exact solver: discrete-time, event-based DFS over states
 * (time, completed set, running jobs) with branch & bound plus
 * dominance memoization. Returns the optimal schedule, or null if no
 * schedule fits within the horizon.
 */
export function solve(problem: Problem): Solution | null {
  validate(problem);
  const ctx = buildCtx(problem);
  const { n, horizon, dur, width, depMask, tail, fullMask } = ctx;
  const choices = problem.jobs.map((j) => workerChoices(j.skill));

  let best = Math.min(greedy(problem, ctx), horizon) + 1;
  const result: { entries: ScheduledJob[] | null } = { entries: null };
  let nodes = 0;
  const seen = new Map<string, number>();

  const entries: ScheduledJob[] = [];

  function stateKey(t: number, completed: number, running: Running[]): string {
    const sig = running
      .map((r) => `${r.idx}:${r.end - t}:${r.workers.join("")}`)
      .sort()
      .join(",");
    return `${completed}|${sig}`;
  }

  function search(t: number, completed: number, running: Running[]): void {
    nodes++;
    if (completed === fullMask) {
      if (t < best) {
        best = t;
        result.entries = entries.map((e) => ({ ...e, workers: [...e.workers] }));
      }
      return;
    }
    // Lower bounds: total remaining worker-time / 2, and precedence chains.
    let work = 0;
    let chain = 0;
    const runningIdx = new Set<number>();
    for (const r of running) {
      runningIdx.add(r.idx);
      work += (r.end - t) * width[r.idx];
      chain = Math.max(chain, r.end - t + tail[r.idx] - dur[r.idx]);
    }
    for (let j = 0; j < n; j++) {
      const bit = 1 << j;
      if (completed & bit || runningIdx.has(j)) continue;
      work += dur[j] * width[j];
      chain = Math.max(chain, tail[j]);
    }
    if (t + Math.max(Math.ceil(work / 2), chain) >= best) return;

    const key = stateKey(t, completed, running);
    const prev = seen.get(key);
    if (prev !== undefined && prev <= t) return;
    seen.set(key, t);

    const freeA = !running.some((r) => r.workers.includes(0));
    const freeB = !running.some((r) => r.workers.includes(1));
    const ready: number[] = [];
    for (let j = 0; j < n; j++) {
      const bit = 1 << j;
      if (completed & bit || runningIdx.has(j)) continue;
      if ((depMask[j] & ~completed) === 0) ready.push(j);
    }

    // Candidate start-sets for this event time (idle handled separately).
    type Start = { idx: number; workers: number[] };
    const options: Start[][] = [];
    const singles = ready.filter((j) => problem.jobs[j].skill !== "both");
    if (freeA && freeB) {
      for (const j of ready) {
        if (problem.jobs[j].skill === "both") options.push([{ idx: j, workers: [0, 1] }]);
      }
      for (const j of singles) {
        for (const ws of choices[j]) options.push([{ idx: j, workers: ws }]);
      }
      for (let a = 0; a < singles.length; a++) {
        for (let b = a + 1; b < singles.length; b++) {
          for (const wa of choices[singles[a]]) {
            for (const wb of choices[singles[b]]) {
              if (wa[0] !== wb[0]) {
                options.push([
                  { idx: singles[a], workers: wa },
                  { idx: singles[b], workers: wb },
                ]);
              }
            }
          }
        }
      }
    } else if (freeA || freeB) {
      const w = freeA ? 0 : 1;
      for (const j of singles) {
        for (const ws of choices[j]) if (ws[0] === w) options.push([{ idx: j, workers: ws }]);
      }
    }
    // Idling is only meaningful while something is still running.
    if (running.length > 0) options.push([]);
    // Try "do more / longer work first" for faster bound tightening.
    options.sort((x, y) => {
      const score = (o: Start[]) =>
        o.length * 1000 + o.reduce((s, st) => s + dur[st.idx], 0);
      return score(y) - score(x);
    });

    for (const option of options) {
      const next = running.slice();
      for (const st of option) {
        next.push({ idx: st.idx, end: t + dur[st.idx], workers: st.workers });
        entries.push({
          index: st.idx,
          id: problem.jobs[st.idx].id,
          start: t,
          end: t + dur[st.idx],
          workers: [...st.workers],
        });
      }
      const nextT = Math.min(...next.map((r) => r.end));
      let nextCompleted = completed;
      const still: Running[] = [];
      for (const r of next) {
        if (r.end === nextT) nextCompleted |= 1 << r.idx;
        else still.push(r);
      }
      search(nextT, nextCompleted, still);
      entries.length -= option.length;
    }
  }

  search(0, 0, []);
  if (!result.entries) return null;
  result.entries.sort((a, b) => a.start - b.start || a.index - b.index);
  return { makespan: best, entries: result.entries, nodes };
}
