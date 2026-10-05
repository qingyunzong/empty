// Minimal ambient declarations for the Node built-ins used by the tests.
// Keeps the project dependency-free (offline-friendly); replace with
// @types/node when network access is available.
declare module 'node:test' {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module 'node:assert/strict' {
  interface Assert {
    (value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): asserts value;
    match(actual: string, regexp: RegExp, message?: string): void;
    throws(fn: () => unknown, error?: unknown, message?: string): any;
    doesNotThrow(fn: () => unknown, message?: string): void;
  }
  const assert: Assert;
  export default assert;
}
