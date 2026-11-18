import { canonicalize } from "./canonical.ts";

export type AggregateKind =
  | "count"
  | "sum"
  | "avg"
  | "min"
  | "max"
  | "distinctCount"
  | "custom";

export interface AggregateSpec<TValue = unknown> {
  readonly kind: AggregateKind;
  readonly expression?: (...rows: any[]) => TValue;
  readonly custom?: {
    readonly initial: () => unknown;
    readonly add: (state: any, rows: any[]) => void;
    readonly remove: (state: any, rows: any[]) => void;
    readonly value: (state: any) => unknown;
  };
}

type Invoke = (fn: (...rows: any[]) => unknown, rows: any[]) => unknown;

export interface AggregateAccumulator {
  readonly spec: AggregateSpec;
  state: any;
}

function isMissing(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

function numericValue(value: unknown, aggregate: string): number {
  if (isMissing(value)) return 0;
  if (typeof value !== "number") {
    throw new TypeError(`${aggregate}() expects numbers, received ${typeof value}`);
  }
  return value;
}

function compareValues(left: unknown, right: unknown): number {
  if ((left as any) < (right as any)) return -1;
  if ((left as any) > (right as any)) return 1;
  return 0;
}

function emptyState(kind: AggregateKind): any {
  switch (kind) {
    case "count":
      return { count: 0 };
    case "sum":
    case "avg":
      return { sum: 0, count: 0 };
    case "min":
    case "max":
      return { values: new Map<string, { value: unknown; count: number }>(), best: undefined, hasBest: false };
    case "distinctCount":
      return { values: new Map<string, { value: unknown; count: number }>() };
    case "custom":
      throw new Error("custom aggregate requires an initializer");
  }
}

export function createAccumulator(spec: AggregateSpec): AggregateAccumulator {
  const state = spec.kind === "custom" ? spec.custom!.initial() : emptyState(spec.kind);
  return { spec, state };
}

function evaluate(spec: AggregateSpec, rows: any[], invoke: Invoke): unknown {
  return spec.expression ? invoke(spec.expression, rows) : undefined;
}

export function accumulatorAdd(
  accumulator: AggregateAccumulator,
  rows: any[],
  invoke: Invoke,
  contribution = 1,
): void {
  const { spec, state } = accumulator;
  switch (spec.kind) {
    case "count": {
      if (!spec.expression) {
        state.count += contribution;
      } else {
        const value = evaluate(spec, rows, invoke);
        if (!isMissing(value)) state.count += contribution;
      }
      return;
    }
    case "sum":
    case "avg": {
      const value = evaluate(spec, rows, invoke);
      if (!isMissing(value)) {
        state.sum += numericValue(value, spec.kind);
        state.count += contribution;
      }
      return;
    }
    case "min":
    case "max": {
      const value = evaluate(spec, rows, invoke);
      if (isMissing(value)) return;
      const key = canonicalize(value);
      const existing = state.values.get(key);
      if (existing) {
        existing.count += contribution;
      } else {
        state.values.set(key, { value, count: contribution });
      }
      if (!state.hasBest) {
        state.best = value;
        state.hasBest = true;
      } else {
        const comparison = compareValues(value, state.best);
        if ((spec.kind === "min" && comparison < 0) || (spec.kind === "max" && comparison > 0)) {
          state.best = value;
        }
      }
      return;
    }
    case "distinctCount": {
      const value = evaluate(spec, rows, invoke);
      if (isMissing(value)) return;
      const key = canonicalize(value);
      const existing = state.values.get(key);
      if (existing) existing.count += contribution;
      else state.values.set(key, { value, count: contribution });
      return;
    }
    case "custom":
      spec.custom!.add(state, rows);
      return;
  }
}

function recomputeBest(state: any, kind: "min" | "max"): void {
  state.best = undefined;
  state.hasBest = false;
  for (const entry of state.values.values()) {
    if (entry.count <= 0) continue;
    if (!state.hasBest) {
      state.best = entry.value;
      state.hasBest = true;
      continue;
    }
    const comparison = compareValues(entry.value, state.best);
    if ((kind === "min" && comparison < 0) || (kind === "max" && comparison > 0)) {
      state.best = entry.value;
    }
  }
}

export function accumulatorRemove(
  accumulator: AggregateAccumulator,
  rows: any[],
  invoke: Invoke,
  contribution = 1,
): void {
  const { spec, state } = accumulator;
  switch (spec.kind) {
    case "count": {
      if (!spec.expression) {
        state.count -= contribution;
      } else {
        const value = evaluate(spec, rows, invoke);
        if (!isMissing(value)) state.count -= contribution;
      }
      if (state.count < 0) throw new Error("count aggregate went negative");
      return;
    }
    case "sum":
    case "avg": {
      const value = evaluate(spec, rows, invoke);
      if (!isMissing(value)) {
        state.sum -= numericValue(value, spec.kind);
        state.count -= contribution;
      }
      if (state.count < 0) throw new Error(`${spec.kind} aggregate count went negative`);
      return;
    }
    case "min":
    case "max": {
      const value = evaluate(spec, rows, invoke);
      if (isMissing(value)) return;
      const key = canonicalize(value);
      const existing = state.values.get(key);
      if (!existing) throw new Error(`${spec.kind} aggregate saw an unknown value during removal`);
      existing.count -= contribution;
      if (existing.count < 0) throw new Error(`${spec.kind} aggregate multiplicity went negative`);
      if (existing.count === 0) {
        state.values.delete(key);
        if (state.hasBest && canonicalize(state.best) === key) {
          recomputeBest(state, spec.kind);
        }
      }
      return;
    }
    case "distinctCount": {
      const value = evaluate(spec, rows, invoke);
      if (isMissing(value)) return;
      const key = canonicalize(value);
      const existing = state.values.get(key);
      if (!existing) throw new Error("distinctCount aggregate saw an unknown value during removal");
      existing.count -= contribution;
      if (existing.count < 0) throw new Error("distinctCount aggregate multiplicity went negative");
      if (existing.count === 0) state.values.delete(key);
      return;
    }
    case "custom":
      spec.custom!.remove(state, rows);
      return;
  }
}

export function accumulatorValue(accumulator: AggregateAccumulator): unknown {
  const { spec, state } = accumulator;
  switch (spec.kind) {
    case "count":
      return state.count;
    case "sum":
      return state.sum;
    case "avg":
      return state.count === 0 ? undefined : state.sum / state.count;
    case "min":
    case "max":
      return state.hasBest ? state.best : undefined;
    case "distinctCount":
      return state.values.size;
    case "custom":
      return spec.custom!.value(state);
  }
}

export function count<TValue = unknown>(
  expression?: ((...rows: any[]) => TValue) | "*" | null,
): AggregateSpec<TValue> {
  if (expression === "*" || expression === null) return { kind: "count" };
  return { kind: "count", expression };
}

export function sum(expression: (...rows: any[]) => number): AggregateSpec<number> {
  return { kind: "sum", expression };
}

export function avg(expression: (...rows: any[]) => number): AggregateSpec<number> {
  return { kind: "avg", expression };
}

export function min<TValue = unknown>(
  expression: (...rows: any[]) => TValue,
): AggregateSpec<TValue> {
  return { kind: "min", expression };
}

export function max<TValue = unknown>(
  expression: (...rows: any[]) => TValue,
): AggregateSpec<TValue> {
  return { kind: "max", expression };
}

export function distinctCount<TValue = unknown>(
  expression: (...rows: any[]) => TValue,
): AggregateSpec<TValue> {
  return { kind: "distinctCount", expression };
}

export interface CustomAggregateOptions<TState, TValue> {
  initial: () => TState;
  add: (state: TState, rows: any[]) => void;
  remove: (state: TState, rows: any[]) => void;
  value: (state: TState) => TValue;
}

export function defineAggregate<TState, TValue>(
  options: CustomAggregateOptions<TState, TValue>,
): AggregateSpec<TValue> {
  return {
    kind: "custom",
    custom: options as CustomAggregateOptions<unknown, TValue>,
  };
}
