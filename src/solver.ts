/**
 * Primary solver: time-ordered search over (completedMask, temp, time) with
 * Pareto dominance pruning. For a fixed mask, state A dominates state B when
 * A.temp <= B.temp and A.time <= B.time (cooler and earlier is never worse).
 * Non-preemptive: starting a task jumps forward its full duration, checking
 * the temperature ceiling at every intermediate tick. States are processed in
 * increasing time order (bucket queue over 0..maxTicks), so the first popped
 * state with all tasks complete has the minimal makespan.
 */

import type { Problem } from "./model.js";

export interface TickAction {
  tick: number; // 1-based tick index
  action: string; // "idle" or task id
  temp: number; // temperature after this tick
}

export interface TaskRun {
  id: string;
  start: number; // time at which the task starts (its first tick is start+1)
  end: number; // time at which the task completes
}

export interface SolveResult {
  feasible: boolean;
  makespan: number; // -1 when infeasible
  runs: TaskRun[];
  trajectory: TickAction[];
  statesExplored: number;
}

interface Node {
  mask: number;
  temp: number;
  time: number;
  prev: number; // index into nodes array, -1 for root
  task: number; // task index started to reach this node, -1 for idle/root
}

export function solve(p: Problem): SolveResult {
  const n = p.tasks.length;
  const full = (1 << n) - 1;

  const nodes: Node[] = [{ mask: 0, temp: p.initialTemp, time: 0, prev: -1, task: -1 }];
  const buckets: number[][] = Array.from({ length: p.maxTicks + 1 }, () => []);
  buckets[0]!.push(0);
  // Pareto frontier per mask: list of (temp, time) kept non-dominated.
  const pareto = new Map<number, Array<[number, number]>>();
  pareto.set(0, [[p.initialTemp, 0]]);
  let explored = 0;

  for (let t = 0; t <= p.maxTicks; t++) {
    for (const idx of buckets[t]!) {
      const cur = nodes[idx]!;
      explored++;
      if (cur.mask === full) {
        return buildResult(p, nodes, idx, explored);
      }
      // Option 1: idle one tick to cool down.
      if (t + 1 <= p.maxTicks) {
        const t2 = Math.max(0, cur.temp - p.coolingRate);
        push(nodes, buckets, pareto, cur.mask, t2, t + 1, idx, -1);
      }
      // Option 2: start any unfinished task that can still meet its deadline.
      for (let i = 0; i < n; i++) {
        if (cur.mask & (1 << i)) continue;
        const task = p.tasks[i]!;
        const end = t + task.duration;
        if (end > task.deadline || end > p.maxTicks) continue;
        let temp = cur.temp;
        let ok = true;
        for (let k = 0; k < task.duration; k++) {
          temp += task.heat;
          if (temp > p.maxTemp) { ok = false; break; }
        }
        if (!ok) continue;
        push(nodes, buckets, pareto, cur.mask | (1 << i), temp, end, idx, i);
      }
    }
  }
  return { feasible: false, makespan: -1, runs: [], trajectory: [], statesExplored: explored };
}

function push(
  nodes: Node[],
  buckets: number[][],
  pareto: Map<number, Array<[number, number]>>,
  mask: number,
  temp: number,
  time: number,
  prev: number,
  task: number,
): void {
  let list = pareto.get(mask);
  if (list === undefined) {
    list = [];
    pareto.set(mask, list);
  }
  for (const [t0, tm0] of list) {
    if (t0 <= temp && tm0 <= time) return; // dominated
  }
  // Remove entries dominated by the new state.
  for (let i = list.length - 1; i >= 0; i--) {
    const [t0, tm0] = list[i]!;
    if (temp <= t0 && time <= tm0) list.splice(i, 1);
  }
  list.push([temp, time]);
  nodes.push({ mask, temp, time, prev, task });
  buckets[time]!.push(nodes.length - 1);
}

function buildResult(p: Problem, nodes: Node[], goal: number, explored: number): SolveResult {
  const runs: TaskRun[] = [];
  const actions: Array<{ task: number }> = [];
  let idx = goal;
  while (nodes[idx]!.prev !== -1) {
    const nd = nodes[idx]!;
    actions.push({ task: nd.task });
    idx = nd.prev;
  }
  actions.reverse();

  const trajectory: TickAction[] = [];
  let temp = p.initialTemp;
  let now = 0;
  for (const a of actions) {
    if (a.task === -1) {
      temp = Math.max(0, temp - p.coolingRate);
      now += 1;
      trajectory.push({ tick: now, action: "idle", temp });
    } else {
      const task = p.tasks[a.task]!;
      const start = now;
      for (let k = 0; k < task.duration; k++) {
        temp += task.heat;
        now += 1;
        trajectory.push({ tick: now, action: task.id, temp });
      }
      runs.push({ id: task.id, start, end: now });
    }
  }
  return {
    feasible: true,
    makespan: nodes[goal]!.time,
    runs,
    trajectory,
    statesExplored: explored,
  };
}
