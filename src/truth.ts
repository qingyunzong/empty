/**
 * Finite truth-table verification.
 *
 * For a form with n fields there are 2^n candidate visibility assignments.
 * An assignment S is a fixpoint iff evaluating every condition with exactly
 * the fields in S treated as visible (all others hidden/unfilled) reproduces
 * S. `enumerateFixpoints` lists them all; the fixpoint iteration from the
 * all-hidden assignment must yield the unique least fixpoint (by inclusion).
 */

import { CompiledSchema, FormSchema, ValueMap, compileSchema, computeVisibility } from "./form";
import { evaluate } from "./expr";

function isCompiled(schema: FormSchema | CompiledSchema): schema is CompiledSchema {
  return "index" in schema;
}

/** Evaluate all conditions under a candidate visibility assignment. */
export function stepAssignment(
  schema: FormSchema | CompiledSchema,
  values: ValueMap,
  assignment: ReadonlySet<string>,
): Set<string> {
  const compiled = isCompiled(schema) ? schema : compileSchema(schema);
  const next = new Set<string>();
  for (const field of compiled.fields) {
    const show = evaluate(field.when, (name) => ({
      visible: assignment.has(name),
      value: values[name],
    }));
    if (show) next.add(field.name);
  }
  return next;
}

/** Enumerate all fixpoint assignments (as sorted name arrays) via the full 2^n truth table. */
export function enumerateFixpoints(
  schema: FormSchema | CompiledSchema,
  values: ValueMap,
): string[][] {
  const compiled = isCompiled(schema) ? schema : compileSchema(schema);
  const names = compiled.fields.map((f) => f.name);
  const fixpoints: string[][] = [];
  const total = 1 << names.length;
  for (let mask = 0; mask < total; mask++) {
    const assignment = new Set<string>();
    for (let i = 0; i < names.length; i++) {
      if (mask & (1 << i)) assignment.add(names[i]!);
    }
    const next = stepAssignment(compiled, values, assignment);
    if (next.size === assignment.size && [...next].every((n) => assignment.has(n))) {
      fixpoints.push(names.filter((n) => assignment.has(n)));
    }
  }
  return fixpoints;
}

export interface TruthTableVerification {
  readonly ok: boolean;
  readonly computed: readonly string[];
  readonly fixpoints: readonly string[][];
  readonly isFixpoint: boolean;
  readonly isLeast: boolean;
  readonly detail: string;
}

/**
 * Verify the computed visibility against the finite truth table:
 * it must be a fixpoint and it must be the least one by set inclusion.
 */
export function verifyWithTruthTable(
  schema: FormSchema | CompiledSchema,
  values: ValueMap,
): TruthTableVerification {
  const compiled = isCompiled(schema) ? schema : compileSchema(schema);
  const computed = computeVisibility(compiled, values).visible;
  const fixpoints = enumerateFixpoints(compiled, values);

  const key = (names: readonly string[]) => [...names].sort().join("");
  const computedKey = key(computed);
  const isFixpoint = fixpoints.some((fp) => key(fp) === computedKey);
  const isLeast = fixpoints.every((fp) => {
    const fpSet = new Set(fp);
    return computed.every((n) => fpSet.has(n));
  });

  const ok = isFixpoint && isLeast;
  const detail = ok
    ? `computed least fixpoint {${computed.join(", ")}}; ${fixpoints.length} fixpoint(s) total`
    : `MISMATCH: computed {${computed.join(", ")}} isFixpoint=${isFixpoint} isLeast=${isLeast}; fixpoints=${JSON.stringify(fixpoints)}`;
  return { ok, computed, fixpoints, isFixpoint, isLeast, detail };
}
