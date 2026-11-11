/**
 * Minimal ambient declarations for Node's built-in test runner and strict
 * assertion module. The runtime provides these; the type packages
 * (@types/node) are not installed in this offline environment. Kept inside
 * test/ so it never leaks into the published build in src/.
 */
declare module "node:test" {
  export function test(name: string, fn: () => unknown | Promise<unknown>): void;
}

declare module "node:assert/strict" {
  interface StrictAssert {
    (value: unknown, message?: string): void;
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    throws(fn: () => unknown, error?: unknown, message?: string): void;
  }
  const assert: StrictAssert;
  export default assert;
}
