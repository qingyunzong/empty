// Minimal ambient declarations for the Node.js built-ins used here,
// because @types/node is not available in this offline environment.
declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
}

declare module "node:assert/strict" {
  interface Assert {
    (value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): asserts value;
    match(actual: string, expected: RegExp, message?: string): void;
    throws(fn: () => unknown, message?: string): void;
  }
  const assert: Assert;
  export default assert;
}
