/**
 * Finite timing conditions, e.g. "within d ticks after A, B must occur and
 * no C may occur". A spec is validated and frozen into a CompiledCondition
 * that a Monitor can instantiate once per observed trigger event.
 */

export interface TimingConditionSpec {
  /** Optional human-readable name; defaults to the trigger event name. */
  readonly name?: string;
  /** Trigger event ("A"): each occurrence spawns a new instance. */
  readonly trigger: string;
  /** Window length d in ticks; the window covers ticks (t, t+d]. */
  readonly windowTicks: number;
  /** Events that must each occur at least once inside the window. */
  readonly require?: readonly string[];
  /** Events that must not occur inside the window. */
  readonly forbid?: readonly string[];
}

export interface CompiledCondition {
  readonly name: string;
  readonly trigger: string;
  readonly windowTicks: number;
  readonly require: readonly string[];
  readonly forbid: readonly string[];
}

function assertEventName(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`condition: ${field} must be a non-empty string`);
  }
}

export function compileCondition(spec: TimingConditionSpec): CompiledCondition {
  if (spec === null || typeof spec !== "object") {
    throw new Error("condition: spec must be an object");
  }
  assertEventName(spec.trigger, "trigger");
  if (!Number.isInteger(spec.windowTicks) || spec.windowTicks < 1) {
    throw new Error("condition: windowTicks must be an integer >= 1");
  }
  const require = [...(spec.require ?? [])];
  const forbid = [...(spec.forbid ?? [])];
  for (const name of require) assertEventName(name, "require entry");
  for (const name of forbid) assertEventName(name, "forbid entry");
  if (new Set(require).size !== require.length) {
    throw new Error("condition: duplicate entries in require");
  }
  if (new Set(forbid).size !== forbid.length) {
    throw new Error("condition: duplicate entries in forbid");
  }
  const overlap = require.filter((name) => forbid.includes(name));
  if (overlap.length > 0) {
    throw new Error(
      `condition: events cannot be both required and forbidden: ${overlap.join(", ")}`,
    );
  }
  return Object.freeze({
    name: spec.name ?? spec.trigger,
    trigger: spec.trigger,
    windowTicks: spec.windowTicks,
    require: Object.freeze(require),
    forbid: Object.freeze(forbid),
  });
}

export function compileConditions(
  specs: readonly TimingConditionSpec[],
): CompiledCondition[] {
  if (!Array.isArray(specs) || specs.length === 0) {
    throw new Error("compileConditions: expected a non-empty array of specs");
  }
  const compiled = specs.map(compileCondition);
  const names = compiled.map((c) => c.name);
  if (new Set(names).size !== names.length) {
    throw new Error("compileConditions: condition names must be unique");
  }
  return compiled;
}
