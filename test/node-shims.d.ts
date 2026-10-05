/**
 * Minimal type shims for the Node built-in modules used by the tests.
 * The project has zero external dependencies, so instead of @types/node
 * we declare exactly the surface we use.
 */
declare module 'node:test' {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module 'node:assert/strict' {
  interface Assert {
    (value: unknown, message?: string): void;
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    throws(fn: () => unknown, pattern?: RegExp, message?: string): void;
  }
  const assert: Assert;
  export default assert;
}
