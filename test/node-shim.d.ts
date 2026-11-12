declare module "node:test" {
  interface TestFunction {
    (name: string, fn: () => void | Promise<void>): void;
  }
  const test: TestFunction;
  export default test;
}

declare module "node:assert/strict" {
  interface Assert {
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    notDeepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    throws(fn: () => unknown, error?: unknown, message?: string): void;
  }
  const assert: Assert;
  export default assert;
}
