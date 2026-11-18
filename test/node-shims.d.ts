/*
 * Minimal declarations for the Node built-ins used by the tests.  The
 * execution environment has Node but not a local @types/node install, and the
 * tests only need these two modules.
 */
declare module "node:test" {
  export function describe(name: string, fn: () => void): void;
  export function it(
    name: string,
    fn: () => void | Promise<void>,
  ): void;
}

declare module "node:assert/strict" {
  const assert: {
    (value: unknown, message?: string): void;
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): asserts value;
    throws(fn: () => unknown, expected?: unknown, message?: string): void;
  };
  export default assert;
}
