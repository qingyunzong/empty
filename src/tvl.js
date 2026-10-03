import { typeError } from './errors.js';

export const TRUE = 'true';
export const FALSE = 'false';
export const UNKNOWN = 'unknown';

export const tvNot = (v) => (v === TRUE ? FALSE : v === FALSE ? TRUE : UNKNOWN);

export function tvAnd(a, b) {
  if (a === FALSE || b === FALSE) return FALSE;
  if (a === TRUE && b === TRUE) return TRUE;
  return UNKNOWN;
}

export function tvOr(a, b) {
  if (a === TRUE || b === TRUE) return TRUE;
  if (a === FALSE && b === FALSE) return FALSE;
  return UNKNOWN;
}

export function tvCompare(op, a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return UNKNOWN;
  if (typeof a !== typeof b) {
    throw typeError(`cannot compare ${typeof a} with ${typeof b} (operator ${op})`);
  }
  switch (op) {
    case '=':
      return a === b ? TRUE : FALSE;
    case '!=':
    case '<>':
      return a !== b ? TRUE : FALSE;
    case '<':
    case '<=':
    case '>':
    case '>=':
      if (typeof a === 'boolean') throw typeError(`cannot order booleans with ${op}`);
      if (op === '<') return a < b ? TRUE : FALSE;
      if (op === '<=') return a <= b ? TRUE : FALSE;
      if (op === '>') return a > b ? TRUE : FALSE;
      return a >= b ? TRUE : FALSE;
    default:
      throw typeError(`unknown comparison operator ${op}`);
  }
}
