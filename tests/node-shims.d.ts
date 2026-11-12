declare module "node:assert/strict" {
  interface Assert {
    ok(value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    fail(message?: string): never;
  }

  const assert: Assert;
  export default assert;
}

declare module "node:test" {
  const test: (name: string, fn: () => unknown) => unknown;
  export default test;
}
