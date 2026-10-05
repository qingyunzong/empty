export interface TaskDefinition {
  id: string;
  deps?: readonly string[];
}

export class CycleError extends Error {
  readonly cycle: readonly string[];
  constructor(cycle: readonly string[]) {
    super(`dependency cycle detected: ${cycle.join(" -> ")}`);
    this.name = "CycleError";
    this.cycle = cycle;
  }
}

export class UnknownDependencyError extends Error {
  readonly taskId: string;
  readonly missingDep: string;
  constructor(taskId: string, missingDep: string) {
    super(`task "${taskId}" depends on unknown task "${missingDep}"`);
    this.name = "UnknownDependencyError";
    this.taskId = taskId;
    this.missingDep = missingDep;
  }
}

export class DuplicateTaskError extends Error {
  constructor(id: string) {
    super(`duplicate task id "${id}"`);
    this.name = "DuplicateTaskError";
  }
}

export interface Graph {
  /** task id -> ids of its direct dependencies */
  readonly deps: ReadonlyMap<string, readonly string[]>;
  /** task id -> ids of tasks that directly depend on it */
  readonly dependents: ReadonlyMap<string, readonly string[]>;
  /** deterministic topological order (deps before dependents, ids sorted among ready) */
  readonly order: readonly string[];
}

export function buildGraph(tasks: readonly TaskDefinition[]): Graph {
  const deps = new Map<string, readonly string[]>();
  for (const task of tasks) {
    if (deps.has(task.id)) throw new DuplicateTaskError(task.id);
    deps.set(task.id, task.deps ?? []);
  }
  for (const [id, depIds] of deps) {
    for (const dep of depIds) {
      if (!deps.has(dep)) throw new UnknownDependencyError(id, dep);
    }
  }

  // Cycle detection via iterative DFS, recording the exact cycle path.
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const id of deps.keys()) color.set(id, WHITE);
  const stack: string[] = [];

  const visit = (start: string): void => {
    color.set(start, GRAY);
    stack.push(start);
    for (const dep of deps.get(start)!) {
      const c = color.get(dep)!;
      if (c === GRAY) {
        const from = stack.indexOf(dep);
        throw new CycleError([...stack.slice(from), dep]);
      }
      if (c === WHITE) visit(dep);
    }
    stack.pop();
    color.set(start, BLACK);
  };
  for (const id of deps.keys()) {
    if (color.get(id) === WHITE) visit(id);
  }

  const dependents = new Map<string, string[]>();
  for (const id of deps.keys()) dependents.set(id, []);
  for (const [id, depIds] of deps) {
    for (const dep of depIds) dependents.get(dep)!.push(id);
  }

  // Deterministic topological order: Kahn's algorithm with sorted ready set.
  const indegree = new Map<string, number>();
  for (const [id, depIds] of deps) indegree.set(id, depIds.length);
  const ready = [...deps.keys()].filter((id) => indegree.get(id) === 0).sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const next of dependents.get(id)!) {
      const d = indegree.get(next)! - 1;
      indegree.set(next, d);
      if (d === 0) {
        const at = ready.findIndex((r) => r > next);
        if (at === -1) ready.push(next);
        else ready.splice(at, 0, next);
      }
    }
  }

  return { deps, dependents, order };
}
