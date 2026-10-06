// Minimal ambient declarations for the Node APIs used by this project.
// The environment has no network access, so @types/node cannot be installed;
// these shims cover exactly what the library and tests use.

declare function queueMicrotask(callback: () => void): void;

declare module "node:test" {
  export function test(
    name: string,
    fn: () => void | Promise<void>,
  ): void;
}

declare module "node:assert/strict" {
  interface AssertStrict {
    (value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    throws(
      fn: () => unknown,
      expected?: RegExp | Error,
      message?: string,
    ): void;
  }
  const assert: AssertStrict;
  export default assert;
}
