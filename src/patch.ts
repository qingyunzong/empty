import type {
  MergePatch,
  PatchMerge,
  PatchReplace,
} from "./types.ts";
import {
  cloneValue,
  compareStrings,
  deepEqual,
  hasOwn,
  isPlainObject,
  setOwn,
} from "./utils.ts";

function presentField(
  object: Record<string, unknown>,
  key: string,
): boolean {
  return hasOwn(object, key) && object[key] !== undefined;
}

/**
 * Compute the smallest object-shaped patch that transforms `current` into
 * `target`. Arrays and scalars are replaced atomically inside the patch.
 */
export function createPatch(
  current: unknown,
  target: unknown,
): MergePatch {
  const patch = diffValue(current, target);
  return patch ?? { op: "merge", fields: {} };
}

function diffValue(
  current: unknown,
  target: unknown,
): MergePatch | undefined {
  if (deepEqual(current, target)) return undefined;
  if (target === undefined) return { op: "remove" };

  if (isPlainObject(current) && isPlainObject(target)) {
    const keys = new Set([
      ...Object.keys(current),
      ...Object.keys(target),
    ]);
    const fieldNames = [...keys].sort(compareStrings);
    const fields: Record<string, MergePatch> = {};
    let changed = false;

    for (const key of fieldNames) {
      const currentHas = presentField(current, key);
      const targetHas = presentField(target, key);
      if (!targetHas) {
        if (currentHas) {
          setOwn(fields, key, { op: "remove" });
          changed = true;
        }
        continue;
      }
      if (!currentHas) {
        setOwn(fields, key, {
          op: "replace",
          value: cloneValue(target[key]),
        });
        changed = true;
        continue;
      }
      const child = diffValue(current[key], target[key]);
      if (child !== undefined) {
        setOwn(fields, key, child);
        changed = true;
      }
    }

    if (!changed) return undefined;
    const merge: PatchMerge = { op: "merge", fields };
    return merge;
  }

  const replace: PatchReplace = {
    op: "replace",
    value: cloneValue(target),
  };
  return replace;
}

/**
 * Apply a patch without mutating the document or the patch. Re-applying the
 * same patch to its own result is a no-op.
 */
export function applyPatch<T = unknown>(
  document: T,
  patch: MergePatch,
): T {
  return applyPatchValue(document, patch) as T;
}

function applyPatchValue(
  document: unknown,
  patch: MergePatch,
): unknown {
  if (patch === null || typeof patch !== "object") {
    throw new TypeError("Invalid merge patch");
  }

  // Accept the common aliases as well, which keeps serialized patches from
  // older callers readable.
  const operation = String((patch as { op?: unknown }).op ?? "");

  if (operation === "remove" || operation === "delete") {
    return undefined;
  }

  if (operation === "replace" || operation === "set") {
    return cloneValue((patch as PatchReplace).value);
  }

  if (operation !== "merge") {
    throw new TypeError(`Unknown patch operation: ${operation || "<missing>"}`);
  }

  const merge = patch as PatchMerge;
  const fields = merge.fields;
  if (!isPlainObject(fields)) {
    throw new TypeError("Merge patch fields must be an object");
  }

  const fieldNames = Object.keys(fields);
  if (fieldNames.length === 0) return cloneValue(document);

  const result: Record<string, unknown> = isPlainObject(document)
    ? (cloneValue(document) as Record<string, unknown>)
    : {};

  for (const key of fieldNames.sort(compareStrings)) {
    const child = fields[key];
    if (!child || typeof child !== "object") {
      throw new TypeError(`Invalid patch for field ${key}`);
    }
    const childOperation = String((child as { op?: unknown }).op ?? "");
    if (childOperation === "remove" || childOperation === "delete") {
      delete result[key];
      continue;
    }

    const existing = presentField(result, key) ? result[key] : undefined;
    const next = applyPatchValue(existing, child);
    if (next === undefined) delete result[key];
    else setOwn(result, key, next);
  }

  return result;
}

export const applyMergePatch = applyPatch;

export function emptyPatch(): MergePatch {
  return { op: "merge", fields: {} };
}
