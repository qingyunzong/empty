/** Skill requirement of a job: which worker(s) it occupies. */
export type Skill = "A" | "B" | "any" | "both";

export interface Job {
  id: string;
  /** Integer duration in time slots, >= 1. */
  duration: number;
  /** "A"/"B": only that worker; "any": exactly one worker; "both": both workers synchronously. */
  skill: Skill;
  /** Ids of jobs that must finish before this one starts. */
  deps: string[];
}

export interface Problem {
  jobs: Job[];
  /** Integer time horizon; a solution must finish within [0, horizon]. */
  horizon: number;
}

export const MAX_JOBS = 14;

/** Throws on malformed input (unknown/dup ids, cycles, bad durations, ...). */
export function validate(problem: Problem): void {
  const { jobs, horizon } = problem;
  if (!Number.isInteger(horizon) || horizon < 1) {
    throw new Error(`horizon must be a positive integer, got ${horizon}`);
  }
  if (jobs.length > MAX_JOBS) {
    throw new Error(`at most ${MAX_JOBS} jobs supported, got ${jobs.length}`);
  }
  const index = new Map<string, number>();
  jobs.forEach((job, i) => {
    if (index.has(job.id)) throw new Error(`duplicate job id: ${job.id}`);
    index.set(job.id, i);
    if (!Number.isInteger(job.duration) || job.duration < 1) {
      throw new Error(`job ${job.id}: duration must be a positive integer, got ${job.duration}`);
    }
    if (!["A", "B", "any", "both"].includes(job.skill)) {
      throw new Error(`job ${job.id}: unknown skill ${job.skill}`);
    }
  });
  for (const job of jobs) {
    for (const dep of job.deps) {
      if (!index.has(dep)) throw new Error(`job ${job.id}: unknown dependency ${dep}`);
      if (dep === job.id) throw new Error(`job ${job.id}: self dependency`);
    }
  }
  // Cycle check via DFS colors.
  const color = new Array<number>(jobs.length).fill(0);
  const visit = (i: number): void => {
    if (color[i] === 1) throw new Error("dependency cycle detected");
    if (color[i] === 2) return;
    color[i] = 1;
    for (const dep of jobs[i].deps) visit(index.get(dep)!);
    color[i] = 2;
  };
  for (let i = 0; i < jobs.length; i++) visit(i);
}

/** Worker indices a job may occupy: [0]=worker A, [1]=worker B. */
export function workerChoices(skill: Skill): number[][] {
  switch (skill) {
    case "A": return [[0]];
    case "B": return [[1]];
    case "any": return [[0], [1]];
    case "both": return [[0, 1]];
  }
}
