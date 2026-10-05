// Minimal local type shims for the Node.js built-in modules used by the
// tests, so the project compiles without downloading @types/node.
declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module "node:assert/strict" {
  interface Assert {
    (value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    throws(fn: () => unknown, error?: unknown, message?: string): void;
  }
  const assert: Assert;
  export default assert;
}
