import { describeValue } from './paths.js';

export type ErrorCode =
  | 'type'
  | 'required'
  | 'oneOf.none'
  | 'oneOf.ambiguous'
  | 'cycle'
  | 'ref.unresolved'
  | 'ref.loop';

export interface ValidationError {
  readonly path: string;
  readonly code: ErrorCode;
  readonly message: string;
  /** Populated for `oneOf.ambiguous`: the branches that all matched. */
  readonly branches?: readonly string[];
}

// Errors are ordered by the raw UTF-8 bytes of their path. This differs from
// JavaScript's default UTF-16 code-unit comparison for astral characters
// (e.g. "￿" sorts before "𐀀" bytewise, but after it in UTF-16).
export function comparePathsByteOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

export function compareErrors(a: ValidationError, b: ValidationError): number {
  const byPath = comparePathsByteOrder(a.path, b.path);
  if (byPath !== 0) return byPath;
  if (a.code !== b.code) return a.code < b.code ? -1 : 1;
  return comparePathsByteOrder(a.message, b.message);
}

export function sortErrors(errors: readonly ValidationError[]): ValidationError[] {
  return [...errors].sort(compareErrors);
}

export function typeError(path: string, expected: string, value: unknown): ValidationError {
  return {
    path,
    code: 'type',
    message: `expected ${expected}, got ${describeValue(value)}`,
  };
}

export function requiredError(path: string, key: string): ValidationError {
  return {
    path,
    code: 'required',
    message: `missing required property ${JSON.stringify(key)}`,
  };
}

export function cycleError(path: string, kind: 'object' | 'array'): ValidationError {
  return {
    path,
    code: 'cycle',
    message: `cyclic ${kind} reference in data`,
  };
}

export function oneOfNoneError(path: string, branchCount: number): ValidationError {
  return {
    path,
    code: 'oneOf.none',
    message: `value matches 0 of ${branchCount} oneOf branches`,
  };
}

export function oneOfAmbiguousError(
  path: string,
  matched: readonly number[],
  branchCount: number,
): ValidationError {
  const branches = matched.map((index) => `#/oneOf/${index}`);
  return {
    path,
    code: 'oneOf.ambiguous',
    message: `value matches ${matched.length} of ${branchCount} oneOf branches: ${branches.join(', ')}`,
    branches,
  };
}

export function refLoopError(path: string): ValidationError {
  return {
    path,
    code: 'ref.loop',
    message: 'schema recursion without consuming data (oneOf/$ref cycle)',
  };
}
