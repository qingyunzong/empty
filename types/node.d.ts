// Minimal ambient declarations for the Node built-ins used by the tests.
// (The sandbox has no network access to install @types/node.)
declare module "node:test" {
  type TestFn = () => void | Promise<void>;
  function test(name: string, fn: TestFn): void;
  export default test;
}

declare module "node:assert/strict" {
  const assert: {
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    throws(fn: () => unknown, error?: unknown, message?: string): void;
  };
  export default assert;
}
