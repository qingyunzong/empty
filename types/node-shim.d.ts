// Minimal type shims for the Node built-ins used by the tests.
// The sandbox has no network access, so @types/node cannot be installed;
// if it is available, prefer it and delete this file.
declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): asserts value;
  export function throws(fn: () => unknown, pattern?: RegExp, message?: string): void;
}

declare module "node:test" {
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => void): void;
}
