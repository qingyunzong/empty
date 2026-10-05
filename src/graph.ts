export interface TaskDefinition {
  readonly id: string;
  readonly deps?: readonly string[];
  readonly run: (ctx: TaskContext) => unknown | Promise<unknown>;
}

export interface TaskContext {
  readonly id: string;
  outputOf(depId: string): unknown;
}

export class CycleError extends Error {
  readonly cycle: readonly string[];
  constructor(cycle: readonly string[]) {
    super(`Dependency cycle detected: ${cycle.join(" -> ")}`);
    this.name = "CycleError";
    this.cycle = cycle;
  }
}

export class GraphValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphValidationError";
  }
}

export interface Graph {
  /** Task ids in definition order. */
  readonly order: readonly string[];
  readonly tasks: ReadonlyMap<string, TaskDefinition>;
  readonly deps: ReadonlyMap<string, readonly string[]>;
  /** Direct dependents, each list in definition order. */
  readonly dependents: ReadonlyMap<string, readonly string[]>;
}

export function buildGraph(definitions: readonly TaskDefinition[]): Graph {
  const tasks = new Map<string, TaskDefinition>();
  const order: string[] = [];
  for (const def of definitions) {
    if (tasks.has(def.id)) {
      throw new GraphValidationError(`Duplicate task id: ${def.id}`);
    }
    tasks.set(def.id, def);
    order.push(def.id);
  }

  const deps = new Map<string, readonly string[]>();
  const dependentsLists = new Map<string, string[]>();
  for (const id of order) dependentsLists.set(id, []);

  for (const id of order) {
    const def = tasks.get(id)!;
    const resolved: string[] = [];
    const seen = new Set<string>();
    for (const dep of def.deps ?? []) {
      if (!tasks.has(dep)) {
        throw new GraphValidationError(
          `Task "${id}" depends on unknown task "${dep}"`,
        );
      }
      if (seen.has(dep)) continue;
      seen.add(dep);
      resolved.push(dep);
      dependentsLists.get(dep)!.push(id);
    }
    deps.set(id, resolved);
  }

  rejectCycles(order, deps);

  const dependents = new Map<string, readonly string[]>();
  for (const id of order) dependents.set(id, dependentsLists.get(id)!);
  return { order, tasks, deps, dependents };
}

function rejectCycles(
  order: readonly string[],
  deps: ReadonlyMap<string, readonly string[]>,
): void {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const id of order) color.set(id, WHITE);
  const stack: string[] = [];

  const visit = (id: string): void => {
    color.set(id, GRAY);
    stack.push(id);
    for (const dep of deps.get(id)!) {
      const c = color.get(dep)!;
      if (c === GRAY) {
        const start = stack.indexOf(dep);
        throw new CycleError([...stack.slice(start), dep]);
      }
      if (c === WHITE) visit(dep);
    }
    stack.pop();
    color.set(id, BLACK);
  };

  for (const id of order) {
    if (color.get(id) === WHITE) visit(id);
  }
}
