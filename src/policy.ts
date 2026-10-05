import type { Expr } from './expr.js';

export interface MaskRule {
  readonly field: string;
  readonly when: Expr;
  readonly replacement?: unknown;
}

export interface Policy {
  readonly rowFilter: Expr;
  readonly masks?: readonly MaskRule[];
}

export interface PolicySnapshot {
  readonly id: string;
  readonly rowFilter: Expr;
  readonly masks: readonly MaskRule[];
}

export const DEFAULT_MASK_REPLACEMENT = '***';

let snapshotCounter = 0;

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value as object)) return value;
  seen.add(value as object);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key], seen);
  }
  Object.freeze(value);
  return value;
}

export function createPolicySnapshot(policy: Policy): PolicySnapshot {
  if (policy === null || typeof policy !== 'object') {
    throw new TypeError('policy must be an object');
  }
  if (policy.rowFilter === undefined || policy.rowFilter === null) {
    throw new TypeError('policy.rowFilter is required');
  }
  const cloned = structuredClone(policy) as Policy;
  const snapshot: PolicySnapshot = {
    id: `policy-snapshot-${++snapshotCounter}`,
    rowFilter: cloned.rowFilter,
    masks: (cloned.masks ?? []).map((rule) => ({
      field: rule.field,
      when: rule.when,
      replacement: 'replacement' in rule ? rule.replacement : DEFAULT_MASK_REPLACEMENT,
    })),
  };
  return deepFreeze(snapshot);
}
