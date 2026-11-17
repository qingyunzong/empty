import assert from "node:assert/strict";

export function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

export function deepFreeze(value) {
  if (value === null || typeof value !== "object") return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function assertPatchContract(result, current) {
  const applied = result.patch;
  assert.ok(applied, "a patch is always returned");
  assert.deepEqual(
    result.merged,
    applyTo(result, current),
    "patch applied to current must equal merged",
  );
  const once = applyTo(result, current);
  assert.deepEqual(
    result.merged,
    applyTo(result, once),
    "patch re-application must be idempotent",
  );
}

let applyFn;

export function installApply(fn) {
  applyFn = fn;
}

function applyTo(result, document) {
  return applyFn(document, result.patch);
}
