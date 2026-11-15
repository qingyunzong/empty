declare module "node:test" {
  type TestFunction = () => void | Promise<void>;
  const test: (name: string, fn: TestFunction) => void;
  export default test;
}

declare module "node:assert/strict" {
  interface Assert {
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    throws(fn: () => unknown, expected?: RegExp | Error, message?: string): void;
  }
  const assert: Assert;
  export default assert;
}
