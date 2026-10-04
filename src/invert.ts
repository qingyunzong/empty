import type { Op } from './change.js';

/** Thrown when an inverse batch cannot be built without baseline values. */
export class BaselineRequiredError extends Error {
  readonly keys: string[];
  constructor(keys: string[]) {
    super(`baseline required to invert ops on keys: ${keys.join(', ')}`);
    this.name = 'BaselineRequiredError';
    this.keys = keys;
  }
}

/**
 * Build the inverse batch: applying it right after `ops` restores the
 * original state. Inverse ops are emitted in reverse order.
 *
 * Throws BaselineRequiredError listing every key whose original value is
 * unknown (delete/replace without oldValue).
 */
export function invert(ops: readonly Op[]): Op[] {
  const missing: string[] = [];
  const inverse: Op[] = [];
  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i]!;
    switch (op.kind) {
      case 'insert':
        inverse.push({ kind: 'delete', key: op.key, oldValue: op.value });
        break;
      case 'delete':
        if (op.oldValue === undefined) {
          missing.push(op.key);
        } else {
          inverse.push({ kind: 'insert', key: op.key, value: op.oldValue });
        }
        break;
      case 'replace':
        if (op.oldValue === undefined) {
          missing.push(op.key);
        } else {
          inverse.push({ kind: 'replace', key: op.key, oldValue: op.value, value: op.oldValue });
        }
        break;
    }
  }
  if (missing.length > 0) throw new BaselineRequiredError(missing);
  return inverse;
}
