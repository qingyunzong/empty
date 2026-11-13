declare module "node:test" {
  export const test: (
    name: string,
    fn: () => void | Promise<void>,
  ) => void;
}

declare module "node:assert/strict" {
  interface Assert {
    (value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    throws(fn: () => unknown, expected?: unknown, message?: string): void;
    fail(message?: string): never;
  }

  const assert: Assert;
  export default assert;
}
