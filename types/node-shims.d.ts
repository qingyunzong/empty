// Minimal local shims for the Node built-ins used by tests, so the project
// builds without downloading @types/node (offline environment).
declare module 'node:test' {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module 'node:assert/strict' {
  interface Assert {
    (value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): asserts value;
    throws(
      fn: () => unknown,
      error?: RegExp | (new (...args: never[]) => unknown) | ((e: unknown) => boolean),
      message?: string,
    ): void;
  }
  const assert: Assert;
  export default assert;
}
