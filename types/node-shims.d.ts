// Minimal ambient declarations for the Node.js built-ins used by this
// project. The environment has no network access, so @types/node cannot be
// installed; these cover exactly the surface we touch.

declare function setImmediate(callback: (...args: unknown[]) => void): unknown;

declare module "node:test" {
  type TestFn = () => void | Promise<void>;
  interface TestContext {
    name: string;
  }
  function test(name: string, fn: TestFn): void;
  function test(name: string, opts: unknown, fn: TestFn): void;
  export = test;
}

declare module "node:assert/strict" {
  interface AssertionError extends Error {
    actual?: unknown;
    expected?: unknown;
  }
  interface Assert {
    (value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    notDeepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): asserts value;
    throws(fn: () => unknown, expected?: RegExp | ((err: unknown) => boolean) | object, message?: string): void;
    rejects(promise: Promise<unknown>, expected?: RegExp | ((err: unknown) => boolean) | object, message?: string): Promise<void>;
    fail(message?: string): never;
    match(value: string, regExp: RegExp, message?: string): void;
  }
  const assert: Assert;
  export = assert;
}
