// Minimal ambient declarations for the Node built-ins used in tests.
// (The offline environment has no @types/node; Node itself provides the runtime.)
declare module 'node:test' {
  type TestFn = () => void | Promise<void>;
  interface Test {
    (name: string, fn: TestFn): void;
    skip(name: string, fn: TestFn): void;
  }
  const test: Test;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: TestFn): void;
  export default test;
}

declare module 'node:assert/strict' {
  interface Assert {
    (value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): asserts value;
    throws(fn: () => unknown, matcher?: unknown, message?: string): void;
    doesNotThrow(fn: () => unknown, message?: string): void;
    fail(message?: string): never;
  }
  const assert: Assert;
  export = assert;
}

declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};
