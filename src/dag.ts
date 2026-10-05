export interface StageContext {
  /** Contents of declared input files, keyed by path (null when missing). */
  inputs: Record<string, string | null>;
  /** Outputs of direct dependencies, keyed by stage id. */
  deps: Record<string, unknown>;
}

export type StageFn = (ctx: StageContext) => unknown | Promise<unknown>;

export interface StageDef {
  id: string;
  deps?: string[];
  /** Files whose content feeds this stage's input digest. */
  inputs?: string[];
  run: StageFn;
}

export function validateStages(stages: StageDef[]): Map<string, StageDef> {
  const byId = new Map<string, StageDef>();
  for (const stage of stages) {
    if (byId.has(stage.id)) throw new Error(`duplicate stage id: ${stage.id}`);
    byId.set(stage.id, stage);
  }
  for (const stage of stages) {
    for (const dep of stage.deps ?? []) {
      if (!byId.has(dep)) throw new Error(`stage ${stage.id} depends on unknown stage ${dep}`);
    }
  }
  return byId;
}

/** Kahn's algorithm; throws on cycles. */
export function topoSort(stages: StageDef[]): string[] {
  const byId = validateStages(stages);
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const stage of stages) {
    indegree.set(stage.id, (stage.deps ?? []).length);
    for (const dep of stage.deps ?? []) {
      const list = dependents.get(dep) ?? [];
      list.push(stage.id);
      dependents.set(dep, list);
    }
  }
  const queue = stages.filter((s) => (s.deps ?? []).length === 0).map((s) => s.id);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of dependents.get(id) ?? []) {
      const remaining = indegree.get(next)! - 1;
      indegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }
  if (order.length !== byId.size) {
    const stuck = [...byId.keys()].filter((id) => !order.includes(id));
    throw new Error(`cycle detected involving stages: ${stuck.join(', ')}`);
  }
  return order;
}

/** All transitive dependents of `id` (not including `id` itself). */
export function descendantsOf(stages: StageDef[], id: string): Set<string> {
  validateStages(stages);
  const dependents = new Map<string, string[]>();
  for (const stage of stages) {
    for (const dep of stage.deps ?? []) {
      const list = dependents.get(dep) ?? [];
      list.push(stage.id);
      dependents.set(dep, list);
    }
  }
  const result = new Set<string>();
  const stack = [...(dependents.get(id) ?? [])];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (result.has(current)) continue;
    result.add(current);
    stack.push(...(dependents.get(current) ?? []));
  }
  return result;
}
