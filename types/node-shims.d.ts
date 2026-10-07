declare module 'node:test' {
  export default function test(
    name: string,
    fn: () => void | Promise<void>,
  ): void;
}

declare module 'node:assert/strict' {
  interface AssertionError extends Error {
    [key: string]: unknown;
  }
  interface Assert {
    (value: unknown, message?: string): asserts value;
    ok(value: unknown, message?: string): asserts value;
    fail(message?: string): never;
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    throws<T extends Error>(fn: () => unknown, ctor?: new (...args: never[]) => T): T;
  }
  const assert: Assert;
  export default assert;
}
