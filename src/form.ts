/**
 * Form schema + visibility computation.
 *
 * Visibility is the least fixpoint of "evaluate every condition with hidden
 * fields treated as unfilled", computed by monotone Jacobi iteration starting
 * from the all-hidden assignment: each round evaluates all still-hidden
 * fields against the previous round's snapshot and adds every newly satisfied
 * field at once. Because every condition is validated to be monotone, the
 * iteration converges in at most `fields.length` rounds and the per-round
 * changes are independent of field order.
 */

import {
  Expr,
  E,
  assertMonotone,
  evaluate,
  fieldRefs,
} from "./expr";

export interface FieldDef {
  readonly name: string;
  /** Visibility condition. Defaults to always-visible when omitted. */
  readonly when?: Expr;
}

export interface FormSchema {
  readonly fields: readonly FieldDef[];
}

export class SchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaError";
  }
}

export interface CompiledField {
  readonly name: string;
  readonly when: Expr;
}

export interface CompiledSchema {
  readonly fields: readonly CompiledField[];
  readonly index: ReadonlyMap<string, number>;
}

export function compileSchema(schema: FormSchema): CompiledSchema {
  const seen = new Map<string, number>();
  const fields: CompiledField[] = schema.fields.map((f, i) => {
    if (seen.has(f.name)) {
      throw new SchemaError(`duplicate field name "${f.name}"`);
    }
    seen.set(f.name, i);
    return { name: f.name, when: f.when ?? E.const(true) };
  });
  for (const f of fields) {
    for (const ref of fieldRefs(f.when)) {
      if (!seen.has(ref)) {
        throw new SchemaError(`field "${f.name}" references unknown field "${ref}"`);
      }
    }
    assertMonotone(f.when, `field "${f.name}" visibility condition`);
  }
  return { fields, index: seen };
}

export interface Round {
  /** 1-based round number. */
  readonly round: number;
  /** Fields that became visible during this round. */
  readonly becameVisible: readonly string[];
}

export interface VisibilityResult {
  /** Names of visible fields, in schema order. */
  readonly visible: readonly string[];
  /** Names of hidden fields, in schema order. */
  readonly hidden: readonly string[];
  /** Per-round changes of the fixpoint iteration. */
  readonly rounds: readonly Round[];
}

export type ValueMap = Readonly<Record<string, unknown>>;

/**
 * Compute the least fixpoint of field visibility for the given values,
 * starting from the all-hidden assignment. Hidden fields are treated as
 * unfilled while evaluating conditions. Each round evaluates against the
 * snapshot of the previous round, so per-round changes are deterministic.
 */
export function computeVisibility(
  schema: FormSchema | CompiledSchema,
  values: ValueMap,
): VisibilityResult {
  const compiled = isCompiled(schema) ? schema : compileSchema(schema);
  const visible = new Set<string>();
  const rounds: Round[] = [];

  for (let round = 1; ; round++) {
    const snapshot = new Set(visible);
    const becameVisible: string[] = [];
    for (const field of compiled.fields) {
      if (snapshot.has(field.name)) continue;
      const show = evaluate(field.when, (name) => ({
        visible: snapshot.has(name),
        value: values[name],
      }));
      if (show) becameVisible.push(field.name);
    }
    if (becameVisible.length === 0) break;
    for (const name of becameVisible) visible.add(name);
    rounds.push({ round, becameVisible });
  }

  const visibleList: string[] = [];
  const hiddenList: string[] = [];
  for (const field of compiled.fields) {
    (visible.has(field.name) ? visibleList : hiddenList).push(field.name);
  }
  return { visible: visibleList, hidden: hiddenList, rounds };
}

export interface FormState {
  readonly values: ValueMap;
  readonly result: VisibilityResult;
}

export interface BatchUpdateResult extends VisibilityResult {
  /** The new complete value map (previous values + batch applied atomically). */
  readonly values: ValueMap;
  /** Fields visible before the batch but hidden after. */
  readonly becameHidden: readonly string[];
  /** Fields hidden before the batch but visible after. */
  readonly becameVisible: readonly string[];
}

/**
 * Apply a whole batch of value updates atomically: the new value map is formed
 * first, then visibility is recomputed exactly once as a single fixpoint from
 * the all-hidden assignment. Intermediate per-field states are never observed.
 */
export function applyBatch(
  schema: FormSchema | CompiledSchema,
  previous: FormState | null,
  updates: ValueMap,
): BatchUpdateResult {
  const compiled = isCompiled(schema) ? schema : compileSchema(schema);
  const values: ValueMap = Object.freeze({ ...(previous?.values ?? {}), ...updates });
  const result = computeVisibility(compiled, values);

  const before = new Set(previous?.result.visible ?? []);
  const after = new Set(result.visible);
  const becameVisible = result.visible.filter((n) => !before.has(n));
  const becameHidden = [...before].filter((n) => !after.has(n));

  return { ...result, values, becameVisible, becameHidden };
}

function isCompiled(schema: FormSchema | CompiledSchema): schema is CompiledSchema {
  return "index" in schema;
}
