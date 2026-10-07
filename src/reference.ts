import type {
  PathSegment,
  RootSchema,
  Schema,
  ValidationError,
} from "./schema.js";
import {
  EMPTY_CHAIN,
  NON_PRODUCTIVE_SCHEMA_MESSAGE,
  resolveRef,
  sortErrors,
} from "./schema.js";

function describe(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

// Reference model: the direct recursive definition of the semantics, written
// as plainly as possible. It is used as the differential oracle for the
// iterative validator in `validate.ts`.
export function validateReference(
  root: RootSchema,
  value: unknown,
): ValidationError[] {
  const errors: ValidationError[] = [];
  rec(root, root, value, [], new Set<object>(), EMPTY_CHAIN, errors);
  return sortErrors(errors);
}

function rec(
  root: RootSchema,
  schema: Schema,
  value: unknown,
  path: PathSegment[],
  ancestors: Set<object>,
  chain: ReadonlySet<unknown>,
  errors: ValidationError[],
): void {
  const resolved = resolveRef(schema, root);

  if ("oneOf" in resolved) {
    if (chain.has(resolved)) {
      throw new Error(NON_PRODUCTIVE_SCHEMA_MESSAGE);
    }
    const branchChain = new Set(chain).add(resolved);
    const matched: number[] = [];
    for (let i = 0; i < resolved.oneOf.length; i++) {
      const branchErrors: ValidationError[] = [];
      rec(root, resolved.oneOf[i]!, value, path, ancestors, branchChain, branchErrors);
      if (branchErrors.length === 0) {
        matched.push(i);
      }
    }
    if (matched.length === 0) {
      errors.push({ path, message: "oneOf: no branch matched" });
    } else if (matched.length > 1) {
      errors.push({
        path,
        message: `oneOf: ambiguous, branches [${matched.join(", ")}] all matched`,
      });
    }
    return;
  }

  switch (resolved.type) {
    case "integer": {
      if (!(typeof value === "number" && Number.isInteger(value))) {
        errors.push({
          path,
          message: `expected integer, got ${describe(value)}`,
        });
      }
      return;
    }
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        errors.push({
          path,
          message: `expected object, got ${describe(value)}`,
        });
        return;
      }
      if (ancestors.has(value)) {
        errors.push({ path, message: "circular reference in value" });
        return;
      }
      const record = value as Record<string, unknown>;
      for (const key of resolved.required ?? []) {
        if (!Object.prototype.hasOwnProperty.call(record, key)) {
          errors.push({
            path,
            message: `missing required property ${JSON.stringify(key)}`,
          });
        }
      }
      ancestors.add(value);
      for (const key of Object.keys(resolved.properties ?? {})) {
        if (Object.prototype.hasOwnProperty.call(record, key)) {
          rec(
            root,
            resolved.properties![key]!,
          record[key],
          [...path, key],
          ancestors,
          EMPTY_CHAIN,
          errors,
        );
      }
      }
      ancestors.delete(value);
      return;
    }
    case "array": {
      if (!Array.isArray(value)) {
        errors.push({
          path,
          message: `expected array, got ${describe(value)}`,
        });
        return;
      }
      if (ancestors.has(value)) {
        errors.push({ path, message: "circular reference in value" });
        return;
      }
      ancestors.add(value);
      for (let i = 0; i < value.length; i++) {
        rec(
          root,
          resolved.items,
          value[i],
          [...path, i],
          ancestors,
          EMPTY_CHAIN,
          errors,
        );
      }
      ancestors.delete(value);
      return;
    }
  }
}
