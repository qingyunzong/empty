import type { Problem } from "./model.js";
import { validate, workerChoices } from "./model.js";

export interface ScheduledJob {
  /** Index into problem.jobs. */
  index: number;
  id: string;
  start: number;
  end: number;
  /** Worker indices occupied for the whole [start, end) interval. */
  workers: number[];
}

export interface Solution {
  makespan: number;
  entries: ScheduledJob[];
  /** Search statistics: number of DFS states expanded. */
  nodes: number;
}

/**
 * Verifies a schedule against the problem: durations, skills, dependency order,
 * worker exclusivity, synchronous occupation for "both" jobs, and horizon.
 * Throws on the first violation found.
 */
export function checkSchedule(problem: Problem, solution: Solution): void {
  validate(problem);
  const { jobs, horizon } = problem;
  if (!Number.isInteger(solution.makespan) || solution.makespan > horizon) {
    throw new Error(`makespan ${solution.makespan} exceeds horizon ${horizon}`);
  }
  if (solution.entries.length !== jobs.length) {
    throw new Error(`expected ${jobs.length} entries, got ${solution.entries.length}`);
  }
  const byId = new Map<string, ScheduledJob>();
  for (const e of solution.entries) {
    const job = jobs[e.index];
    if (job.id !== e.id) throw new Error(`entry id mismatch: ${e.id} vs ${job.id}`);
    if (byId.has(e.id)) throw new Error(`job scheduled twice: ${e.id}`);
    byId.set(e.id, e);
    if (e.end - e.start !== job.duration) {
      throw new Error(`job ${e.id}: scheduled length ${e.end - e.start} != duration ${job.duration}`);
    }
    if (e.start < 0 || e.end > solution.makespan) {
      throw new Error(`job ${e.id}: interval [${e.start}, ${e.end}) outside makespan`);
    }
    const allowed = workerChoices(job.skill).some(
      (choice) => choice.length === e.workers.length && choice.every((w) => e.workers.includes(w)),
    );
    if (!allowed) throw new Error(`job ${e.id}: workers [${e.workers}] violate skill ${job.skill}`);
    if (job.skill === "both" && e.workers.length !== 2) {
      throw new Error(`job ${e.id}: "both" job must occupy both workers synchronously`);
    }
  }
  for (const job of jobs) {
    const e = byId.get(job.id)!;
    for (const dep of job.deps) {
      const d = byId.get(dep);
      if (!d) throw new Error(`job ${job.id}: dependency ${dep} not scheduled`);
      if (d.end > e.start) {
        throw new Error(`job ${job.id} starts at ${e.start} before dependency ${dep} ends at ${d.end}`);
      }
    }
  }
  // Worker exclusivity: per worker, per time slot, at most one job.
  for (let worker = 0; worker < 2; worker++) {
    const busy = new Array<boolean>(solution.makespan).fill(false);
    for (const e of solution.entries) {
      if (!e.workers.includes(worker)) continue;
      for (let t = e.start; t < e.end; t++) {
        if (busy[t]) throw new Error(`worker ${worker} double-booked at t=${t} (job ${e.id})`);
        busy[t] = true;
      }
    }
  }
  const actual = Math.max(0, ...solution.entries.map((e) => e.end));
  if (actual !== solution.makespan) {
    throw new Error(`declared makespan ${solution.makespan} != last finish ${actual}`);
  }
}
