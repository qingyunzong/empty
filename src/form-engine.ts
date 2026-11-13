/**
 * 表单依赖字段事务填写引擎。
 *
 * 根据字段依赖图驱动联动下拉、异步校验与条件区域：
 * - 每个字段拥有单调递增的世代号，异步结果只在世代匹配时落地；
 * - 上游变化会撤销下游旧计划（中止在途请求并使其世代失效）；
 * - 构造时检测循环依赖并抛出最小环；
 * - 提交前可生成可复核的最终字段快照。
 */

export type FieldValue = unknown;

export interface Option {
  label: string;
  value: string;
}

export interface FieldContext {
  /** 在途计划在撤销时触发 abort。 */
  signal: AbortSignal;
  /** 本次计划发起时字段的世代号。 */
  generation: number;
  /** 读取其他字段当前值。 */
  get(name: string): FieldValue;
}

export interface FieldDef {
  name: string;
  /** 依赖的上游字段名。 */
  dependsOn?: string[];
  /** 初始值。 */
  initial?: FieldValue;
  /** 联动下拉：依据上游值异步/同步加载选项。 */
  options?: (
    deps: Record<string, FieldValue>,
    ctx: FieldContext,
  ) => Promise<Option[]> | Option[];
  /** 派生值：依据上游值计算本字段值。 */
  compute?: (
    deps: Record<string, FieldValue>,
    ctx: FieldContext,
  ) => Promise<FieldValue> | FieldValue;
  /** 异步校验：返回错误信息列表（空数组表示通过）。 */
  validate?: (
    value: FieldValue,
    deps: Record<string, FieldValue>,
    ctx: FieldContext,
  ) => Promise<string[]> | string[];
  /** 条件区域：依据上游值决定字段是否可见。 */
  visibleWhen?: (deps: Record<string, FieldValue>) => boolean;
}

export interface SectionDef {
  name: string;
  fields: string[];
  visibleWhen?: (values: Record<string, FieldValue>) => boolean;
}

export interface FormConfig {
  fields: FieldDef[];
  sections?: SectionDef[];
}

export type FieldStatus = "pending" | "stable" | "error";

export interface FieldSnapshot {
  name: string;
  value: FieldValue;
  options: Option[] | undefined;
  errors: string[];
  visible: boolean;
  status: FieldStatus;
  generation: number;
}

export interface SectionSnapshot {
  name: string;
  visible: boolean;
  fields: string[];
}

export interface FormSnapshot {
  fields: FieldSnapshot[];
  sections: SectionSnapshot[];
  isValid: boolean;
  isSettled: boolean;
  createdAt: string;
}

export class DependencyCycleError extends Error {
  readonly cycle: string[];
  constructor(cycle: string[]) {
    super(`字段依赖存在循环: ${cycle.join(" -> ")}`);
    this.name = "DependencyCycleError";
    this.cycle = cycle;
  }
}

export class StalePlanError extends Error {
  readonly field: string;
  readonly generation: number;
  constructor(field: string, generation: number) {
    super(`字段 "${field}" 世代 ${generation} 的计划已被更新的输入撤销`);
    this.name = "StalePlanError";
    this.field = field;
    this.generation = generation;
  }
}

export class UnsettledFormError extends Error {
  readonly pending: string[];
  constructor(pending: string[]) {
    super(`表单尚未稳定，无法提交: ${pending.join(", ")}`);
    this.name = "UnsettledFormError";
    this.pending = pending;
  }
}

interface FieldState {
  def: FieldDef;
  value: FieldValue;
  options: Option[] | undefined;
  errors: string[];
  visible: boolean;
  status: FieldStatus;
  generation: number;
  controller: AbortController | null;
}

class StaleRun extends Error {}

export class FormEngine {
  #states = new Map<string, FieldState>();
  #dependents = new Map<string, Set<string>>();
  #sections: SectionDef[];
  #order: string[];

  constructor(config: FormConfig) {
    for (const def of config.fields) {
      if (this.#states.has(def.name)) {
        throw new Error(`字段重复定义: ${def.name}`);
      }
      this.#states.set(def.name, {
        def,
        value: def.initial,
        options: undefined,
        errors: [],
        visible: true,
        status: "pending",
        generation: 0,
        controller: null,
      });
      this.#dependents.set(def.name, new Set());
    }
    for (const def of config.fields) {
      for (const up of def.dependsOn ?? []) {
        if (!this.#states.has(up)) {
          throw new Error(`字段 "${def.name}" 依赖未定义的字段 "${up}"`);
        }
        this.#dependents.get(up)!.add(def.name);
      }
    }
    this.#sections = config.sections ?? [];
    for (const section of this.#sections) {
      for (const name of section.fields) {
        if (!this.#states.has(name)) {
          throw new Error(`条件区域 "${section.name}" 引用了未定义的字段 "${name}"`);
        }
      }
    }
    const cycle = findMinimalCycle(this.#states.keys(), (name) => [
      ...(this.#states.get(name)!.def.dependsOn ?? []),
    ]);
    if (cycle) throw new DependencyCycleError(cycle);
    this.#order = topoOrder(
      [...this.#states.keys()],
      (name) => this.#states.get(name)!.def.dependsOn ?? [],
    );
  }

  /** 字段当前快照。 */
  inspect(name: string): FieldSnapshot {
    return toSnapshot(this.#mustState(name));
  }

  /** 等待初始联动计划稳定。 */
  async ready(): Promise<FormSnapshot> {
    await this.#runPlan(this.#order);
    return this.snapshot();
  }

  /**
   * 录入一个字段值。
   *
   * 返回的 Promise 在该字段及其下游达到与本次输入世代匹配的
   * 稳定结果后兑现为最终字段快照；若期间被更新的输入取代，
   * 则以 StalePlanError 拒绝。
   */
  async setValue(name: string, value: FieldValue): Promise<FieldSnapshot> {
    const state = this.#mustState(name);
    state.value = value;
    const affected = this.#invalidateFrom(name);
    const generation = state.generation;
    await this.#runPlan(affected);
    if (state.generation !== generation) {
      throw new StalePlanError(name, generation);
    }
    return toSnapshot(state);
  }

  /** 提交前生成可复核的最终字段快照；存在未稳定字段时拒绝。 */
  submit(): { ok: boolean; snapshot: FormSnapshot } {
    const pending = [...this.#states.values()]
      .filter((s) => s.status === "pending")
      .map((s) => s.def.name);
    if (pending.length > 0) throw new UnsettledFormError(pending);
    const snapshot = this.snapshot();
    return { ok: snapshot.isValid, snapshot };
  }

  /** 当前表单快照（不校验是否稳定）。 */
  snapshot(): FormSnapshot {
    const fields = this.#order.map((name) => toSnapshot(this.#states.get(name)!));
    const values: Record<string, FieldValue> = {};
    for (const f of fields) values[f.name] = f.value;
    const sections = this.#sections.map((s) => ({
      name: s.name,
      visible: s.visibleWhen ? s.visibleWhen(values) : true,
      fields: [...s.fields],
    }));
    return {
      fields,
      sections,
      isValid: fields.every((f) => f.errors.length === 0 && f.status !== "error"),
      isSettled: fields.every((f) => f.status !== "pending"),
      createdAt: new Date().toISOString(),
    };
  }

  #mustState(name: string): FieldState {
    const state = this.#states.get(name);
    if (!state) throw new Error(`未定义的字段: ${name}`);
    return state;
  }

  /**
   * 从指定字段出发，递增其自身与全部下游字段的世代号并中止在途计划，
   * 返回需要重算的字段（按拓扑序）。
   */
  #invalidateFrom(name: string): string[] {
    const affected = new Set<string>([name]);
    const queue = [name];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const down of this.#dependents.get(current)!) {
        if (!affected.has(down)) {
          affected.add(down);
          queue.push(down);
        }
      }
    }
    for (const field of affected) {
      const state = this.#states.get(field)!;
      state.generation += 1;
      state.controller?.abort();
      state.controller = null;
      state.status = "pending";
    }
    return this.#order.filter((field) => affected.has(field));
  }

  /** 按拓扑序依次重算受影响字段；任一字段世代被取代即放弃整轮计划。 */
  async #runPlan(fields: string[]): Promise<void> {
    for (const name of fields) {
      const state = this.#states.get(name)!;
      const generation = state.generation;
      const controller = new AbortController();
      state.controller = controller;
      const ctx: FieldContext = {
        signal: controller.signal,
        generation,
        get: (dep) => this.#mustState(dep).value,
      };
      const deps: Record<string, FieldValue> = {};
      for (const up of state.def.dependsOn ?? []) deps[up] = this.#states.get(up)!.value;
      try {
        if (state.def.visibleWhen) {
          state.visible = state.def.visibleWhen(deps);
        }
        if (state.def.options) {
          const options = await state.def.options(deps, ctx);
          this.#assertCurrent(state, generation, controller);
          state.options = options;
        }
        if (state.def.compute) {
          const value = await state.def.compute(deps, ctx);
          this.#assertCurrent(state, generation, controller);
          state.value = value;
        }
        if (state.def.validate) {
          const errors = await state.def.validate(state.value, deps, ctx);
          this.#assertCurrent(state, generation, controller);
          state.errors = errors;
        } else {
          state.errors = [];
        }
        state.status = state.errors.length > 0 ? "error" : "stable";
      } catch (err) {
        if (err instanceof StaleRun || controller.signal.aborted) {
          return; // 旧计划被撤销，直接放弃剩余字段
        }
        state.errors = [err instanceof Error ? err.message : String(err)];
        state.status = "error";
      }
    }
  }

  #assertCurrent(state: FieldState, generation: number, controller: AbortController): void {
    if (state.generation !== generation || controller.signal.aborted) {
      throw new StaleRun();
    }
  }
}

function toSnapshot(state: FieldState): FieldSnapshot {
  return {
    name: state.def.name,
    value: state.value,
    options: state.options,
    errors: [...state.errors],
    visible: state.visible,
    status: state.status,
    generation: state.generation,
  };
}

function topoOrder(names: string[], depsOf: (name: string) => string[]): string[] {
  const indegree = new Map<string, number>();
  const downstream = new Map<string, string[]>();
  for (const name of names) {
    indegree.set(name, 0);
    downstream.set(name, []);
  }
  for (const name of names) {
    for (const up of depsOf(name)) {
      indegree.set(name, (indegree.get(name) ?? 0) + 1);
      downstream.get(up)!.push(name);
    }
  }
  const queue = names.filter((n) => indegree.get(n) === 0);
  const order: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    order.push(current);
    for (const down of downstream.get(current)!) {
      const d = indegree.get(down)! - 1;
      indegree.set(down, d);
      if (d === 0) queue.push(down);
    }
  }
  return order;
}

/**
 * 在依赖图中寻找最小环（Tarjan 强连通分量 + 分量内 BFS 最短回路）。
 * 返回构成环的字段名序列（首尾相同），无环时返回 null。
 */
function findMinimalCycle(
  names: Iterable<string>,
  depsOf: (name: string) => string[],
): string[] | null {
  const nodes = [...names];
  const indexOf = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let index = 0;

  const strongconnect = (v: string): void => {
    indexOf.set(v, index);
    lowlink.set(v, index);
    index += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of depsOf(v)) {
      if (!indexOf.has(w)) {
        strongconnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, indexOf.get(w)!));
      }
    }
    if (lowlink.get(v) === indexOf.get(v)) {
      const component: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      if (component.length > 1 || depsOf(v).includes(v)) {
        components.push(component);
      }
    }
  };

  for (const v of nodes) {
    if (!indexOf.has(v)) strongconnect(v);
  }
  if (components.length === 0) return null;

  components.sort((a, b) => a.length - b.length);
  const smallest = components[0];
  if (smallest.length === 1) return [smallest[0], smallest[0]];

  // 在最小的强连通分量内做 BFS，还原最短回路。
  const inComponent = new Set(smallest);
  const cycleFrom = (start: string): string[] | null => {
    const prev = new Map<string, string>();
    const queue = [start];
    const seen = new Set([start]);
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const next of depsOf(current)) {
        if (!inComponent.has(next)) continue;
        if (next === start) {
          const chain = [current];
          let cursor = current;
          while (cursor !== start) {
            cursor = prev.get(cursor)!;
            chain.push(cursor);
          }
          chain.reverse(); // [start, ..., current]
          chain.push(start);
          return chain;
        }
        if (!seen.has(next)) {
          seen.add(next);
          prev.set(next, current);
          queue.push(next);
        }
      }
    }
    return null;
  };
  let best: string[] | null = null;
  for (const start of smallest) {
    const cycle = cycleFrom(start);
    if (cycle && (!best || cycle.length < best.length)) best = cycle;
    if (best && best.length <= 3) break; // 不可能更短
  }
  return best;
}
