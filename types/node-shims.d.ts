// Minimal ambient declarations for the Node.js built-in modules used here.
// The project has no npm dependencies, so these stand in for @types/node.

declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module "node:assert/strict" {
  export function ok(value: unknown, message?: string): asserts value;
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function throws(fn: () => unknown, error?: RegExp, message?: string): void;
  const assert: {
    ok: typeof ok;
    equal: typeof equal;
    notEqual: typeof notEqual;
    deepEqual: typeof deepEqual;
    throws: typeof throws;
  };
  export default assert;
}

declare const console: {
  log(...args: unknown[]): void;
};
