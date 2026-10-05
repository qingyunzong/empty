import { equal } from './canonical.js';
import { applyPlan } from './plan.js';
import type { DocFile, FieldValue, MergeResult, Snapshot } from './types.js';

interface FieldExpectation {
  present: boolean;
  value?: FieldValue;
}

function expectationOf(file: DocFile | undefined, key: string): FieldExpectation {
  if (file !== undefined && Object.prototype.hasOwnProperty.call(file.fields, key)) {
    return { present: true, value: file.fields[key] };
  }
  return { present: false };
}

function fieldEqual(a: DocFile | undefined, key: string, b: DocFile | undefined): boolean {
  const ea = expectationOf(a, key);
  const eb = expectationOf(b, key);
  if (ea.present !== eb.present) return false;
  if (!ea.present) return true;
  return equal(ea.value, eb.value);
}

function expectationMatches(actual: DocFile, key: string, expected: FieldExpectation): boolean {
  const has = Object.prototype.hasOwnProperty.call(actual.fields, key);
  if (has !== expected.present) return false;
  if (!expected.present) return true;
  return equal(actual.fields[key], expected.value);
}

/**
 * Independent per-file three-way cross-check of a merge result.
 * Returns a list of violations; an empty list means the result is consistent
 * with the three-way model, the recorded resolutions, and the change plan.
 */
export function verifyMerge(
  base: Snapshot,
  local: Snapshot,
  remote: Snapshot,
  result: MergeResult,
): string[] {
  const violations: string[] = [];
  const { merged, conflicts, resolved, plan } = result;

  const resolvedByKey = new Map(resolved.map((r) => [r.conflict.key, r]));
  const conflictKeys = new Set(conflicts.map((c) => c.key));
  const occupancyConflictIds = new Set(
    conflicts.filter((c) => c.kind === 'path-occupancy').flatMap((c) => c.fileIds),
  );

  // Paths mandated by applied path-occupancy resolutions.
  const occupancyPath = new Map<string, string>();
  for (const { conflict, choice } of resolved) {
    if (conflict.kind !== 'path-occupancy') continue;
    for (const id of conflict.fileIds) {
      const preferred = choice === 'local' ? local.files[id] : remote.files[id];
      const fallback = choice === 'local' ? remote.files[id] : local.files[id];
      const file = preferred ?? fallback;
      if (file) occupancyPath.set(id, file.path);
    }
  }

  const ids = [
    ...new Set([...Object.keys(base.files), ...Object.keys(local.files), ...Object.keys(remote.files)]),
  ].sort();

  for (const id of ids) {
    const b = base.files[id];
    const l = local.files[id];
    const r = remote.files[id];
    const m = merged.files[id];

    const localChanged = !equal(b ?? null, l ?? null);
    const remoteChanged = !equal(b ?? null, r ?? null);
    const diverged = localChanged && remoteChanged && !equal(l ?? null, r ?? null);

    if (!diverged) {
      let expected = !remoteChanged ? l : r;
      const override = occupancyPath.get(id);
      if (expected && override !== undefined && expected.path !== override) {
        expected = { ...expected, path: override };
      }
      if (expected && !m && occupancyConflictIds.has(id)) {
        continue;
      }
      if (!!m !== !!expected) {
        violations.push(
          `file "${id}": expected ${expected ? 'present' : 'absent'}, got ${m ? 'present' : 'absent'}`,
        );
      } else if (expected && m && !equal(m, expected)) {
        violations.push(`file "${id}": content does not match the three-way expectation`);
      }
      continue;
    }

    // Both sides changed the file in different ways.
    if (!l || !r) {
      const key = `${id}:delete-vs-modify`;
      const applied = resolvedByKey.get(key);
      if (!applied) {
        if (!conflictKeys.has(key)) {
          violations.push(`file "${id}": delete-vs-modify neither resolved nor reported as conflict`);
        }
        if (m) {
          violations.push(`file "${id}": present in merged output despite unresolved conflict`);
        }
      } else {
        const expected = applied.choice === 'local' ? l : r;
        if (!!m !== !!expected || (expected && m && !equal(m, expected))) {
          violations.push(`file "${id}": does not match the resolved "${applied.choice}" outcome`);
        }
      }
      continue;
    }

    // Both sides modified the file: check path and every field.
    let fileConflicted = false;

    let expectedPath: string | null;
    if (l.path === r.path) {
      expectedPath = l.path;
    } else if (b && l.path === b.path) {
      expectedPath = r.path;
    } else if (b && r.path === b.path) {
      expectedPath = l.path;
    } else {
      const key = `${id}:path`;
      const applied = resolvedByKey.get(key);
      if (applied) {
        expectedPath = applied.choice === 'local' ? l.path : r.path;
      } else {
        expectedPath = null;
        fileConflicted = true;
        if (!conflictKeys.has(key)) {
          violations.push(`file "${id}": path conflict neither resolved nor reported`);
        }
      }
    }
    const occupancyOverride = occupancyPath.get(id);
    if (occupancyOverride !== undefined) {
      expectedPath = occupancyOverride;
    }

    const fieldKeys = new Set<string>([
      ...Object.keys(b?.fields ?? {}),
      ...Object.keys(l.fields),
      ...Object.keys(r.fields),
    ]);
    const expectedFields = new Map<string, FieldExpectation>();
    for (const key of [...fieldKeys].sort()) {
      const localFieldChanged = !fieldEqual(b, key, l);
      const remoteFieldChanged = !fieldEqual(b, key, r);
      let expected: FieldExpectation | null;
      if (!localFieldChanged && !remoteFieldChanged) expected = expectationOf(b, key);
      else if (!remoteFieldChanged) expected = expectationOf(l, key);
      else if (!localFieldChanged) expected = expectationOf(r, key);
      else if (fieldEqual(l, key, r)) expected = expectationOf(l, key);
      else {
        const conflictKey = `${id}:field:${key}`;
        const applied = resolvedByKey.get(conflictKey);
        if (applied) {
          expected = expectationOf(applied.choice === 'local' ? l : r, key);
        } else {
          expected = null;
          fileConflicted = true;
          if (!conflictKeys.has(conflictKey)) {
            violations.push(`file "${id}": field "${key}" conflict neither resolved nor reported`);
          }
        }
      }
      if (expected) expectedFields.set(key, expected);
    }

    if (fileConflicted) {
      if (m) {
        violations.push(`file "${id}": present in merged output despite unresolved conflicts`);
      }
      continue;
    }
    if (!m) {
      violations.push(`file "${id}": missing from merged output`);
      continue;
    }
    if (expectedPath !== null && m.path !== expectedPath) {
      violations.push(
        `file "${id}": merged path "${m.path}" does not match expected "${expectedPath}"`,
      );
    }
    for (const key of fieldKeys) {
      const expected = expectedFields.get(key);
      if (expected && !expectationMatches(m, key, expected)) {
        violations.push(`file "${id}": field "${key}" does not match the three-way expectation`);
      }
    }
    for (const key of Object.keys(m.fields)) {
      if (!fieldKeys.has(key)) {
        violations.push(`file "${id}": unexpected field "${key}" in merged output`);
      }
    }
  }

  // Merged snapshot must not contain unknown files or duplicate paths.
  const knownIds = new Set(ids);
  const ownerByPath = new Map<string, string>();
  for (const file of Object.values(merged.files)) {
    if (!knownIds.has(file.id)) {
      violations.push(`merged output contains unknown file "${file.id}"`);
    }
    const owner = ownerByPath.get(file.path);
    if (owner !== undefined) {
      violations.push(`merged output: path "${file.path}" occupied by both "${owner}" and "${file.id}"`);
    }
    ownerByPath.set(file.path, file.id);
  }

  // Plan consistency: conflicts block the plan; a clean merge must reproduce
  // the merged snapshot by applying the plan to the local snapshot.
  if (conflicts.length > 0) {
    if (plan !== null) {
      violations.push('change plan produced despite unresolved conflicts');
    }
  } else {
    if (!plan) {
      violations.push('change plan missing despite a clean merge');
    } else {
      try {
        const applied = applyPlan(local, plan);
        if (!equal(applied.files, merged.files)) {
          violations.push('change plan does not reproduce the merged snapshot');
        }
      } catch (error) {
        violations.push(`change plan failed to apply: ${(error as Error).message}`);
      }
    }
  }

  return violations;
}
