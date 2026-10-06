// Minimal ambient declarations for the Node built-ins used by the tests.
// Keeps the project dependency-free (@types/node is not installed).
declare module 'node:test' {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module 'node:assert/strict' {
  interface Assert {
    (value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): asserts value;
    throws(fn: () => unknown, expected?: unknown, message?: string): void;
  }
  const assert: Assert;
  export default assert;
}
