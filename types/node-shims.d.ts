// Minimal type shims for the Node.js built-in modules used here, so the
// project stays dependency-free (no @types/node install required).
declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module "node:assert/strict" {
  interface Assert {
    (value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    match(value: string, regExp: RegExp, message?: string): void;
  }
  const assert: Assert;
  export default assert;
}
