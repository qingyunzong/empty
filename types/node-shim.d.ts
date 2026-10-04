// Minimal offline shims for the Node.js built-in modules used by the tests.
// The sandbox has no @types/node; these cover only what this project imports.
declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): asserts value;
  export function match(value: string, pattern: RegExp, message?: string): void;
  export function throws(fn: () => unknown, message?: string): void;
  const assert: {
    equal: typeof equal;
    notEqual: typeof notEqual;
    deepEqual: typeof deepEqual;
    ok: typeof ok;
    match: typeof match;
    throws: typeof throws;
  };
  export default assert;
}

declare const console: {
  log(...args: unknown[]): void;
};

declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
}
