import { resolveRefChain, type Schema, type SchemaDocument } from './schema.js';
import { childPath, indexPath } from './paths.js';
import {
  cycleError,
  oneOfAmbiguousError,
  oneOfNoneError,
  refLoopError,
  requiredError,
  sortErrors,
  typeError,
  type ValidationError,
} from './errors.js';

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Reference model: the straightforward recursive formulation of the same
// semantics. It exists as an oracle — the differential tests require
// `validate` (iterative) to produce byte-identical results.
export function validateRecursive(value: unknown, doc: SchemaDocument): ValidationError[] {
  const errors: ValidationError[] = [];
  walk(value, doc.root, '$', doc, errors, new Set(), new Set());
  return sortErrors(errors);
}

function walk(
  value: unknown,
  schema: Schema,
  path: string,
  doc: SchemaDocument,
  errors: ValidationError[],
  ancestors: Set<unknown>,
  spine: ReadonlySet<Schema>,
): void {
  if (spine.has(schema)) {
    errors.push(refLoopError(path));
    return;
  }
  const resolved = resolveRefChain(schema, doc);
  if (!resolved.ok) {
    errors.push({ path, code: resolved.code, message: resolved.message });
    return;
  }
  const s = resolved.schema;

  if ('oneOf' in s) {
    const matched: number[] = [];
    const branchSpine = new Set(spine);
    branchSpine.add(schema);
    for (let i = 0; i < s.oneOf.length; i += 1) {
      const branchErrors: ValidationError[] = [];
      walk(value, s.oneOf[i] as Schema, path, doc, branchErrors, ancestors, branchSpine);
      if (branchErrors.length === 0) matched.push(i);
    }
    if (matched.length === 1) return;
    if (matched.length === 0) {
      errors.push(oneOfNoneError(path, s.oneOf.length));
    } else {
      errors.push(oneOfAmbiguousError(path, matched, s.oneOf.length));
    }
    return;
  }

  if (s.type === 'integer') {
    if (!(typeof value === 'number' && Number.isInteger(value))) {
      errors.push(typeError(path, 'integer', value));
    }
    return;
  }

  if (s.type === 'object') {
    if (!isObjectLike(value)) {
      errors.push(typeError(path, 'object', value));
      return;
    }
    if (ancestors.has(value)) {
      errors.push(cycleError(path, 'object'));
      return;
    }
    ancestors.add(value);
    try {
      for (const key of s.required ?? []) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
          errors.push(requiredError(path, key));
        }
      }
      for (const key of Object.keys(s.properties)) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
          walk(value[key], s.properties[key] as Schema, childPath(path, key), doc, errors, ancestors, new Set());
        }
      }
    } finally {
      ancestors.delete(value);
    }
    return;
  }

  // s.type === 'array'
  if (!Array.isArray(value)) {
    errors.push(typeError(path, 'array', value));
    return;
  }
  if (ancestors.has(value)) {
    errors.push(cycleError(path, 'array'));
    return;
  }
  ancestors.add(value);
  try {
    for (let i = 0; i < value.length; i += 1) {
      walk(value[i], s.items, indexPath(path, i), doc, errors, ancestors, new Set());
    }
  } finally {
    ancestors.delete(value);
  }
}
