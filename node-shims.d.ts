/**
 * Minimal ambient declarations for Node's built-in test runner and assert
 * module. The sandbox has no network access and therefore no @types/node,
 * while the runtime itself provides both modules natively.
 */
declare module 'node:test' {
  type TestFn = () => void | Promise<void>;
  const test: {
    (name: string, fn: TestFn): void;
    (name: string, options: unknown, fn: TestFn): void;
  };
  export default test;
}

declare module 'node:assert/strict' {
  interface Assert {
    (value: unknown, message?: string | Error): void;
    ok(value: unknown, message?: string | Error): void;
    equal(actual: unknown, expected: unknown, message?: string | Error): void;
    deepEqual(actual: unknown, expected: unknown, message?: string | Error): void;
    deepStrictEqual(
      actual: unknown,
      expected: unknown,
      message?: string | Error,
    ): void;
    throws(
      fn: () => unknown,
      matcher?: (error: unknown) => boolean,
      message?: string | Error,
    ): void;
    fail(message?: string | Error): never;
  }
  const assert: Assert;
  export default assert;
}
