declare module "node:test" {
  type TestFunction = () => void | Promise<void>;
  const test: (name: string, fn: TestFunction) => unknown;
  export default test;
}

declare module "node:assert/strict" {
  interface Assert {
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    equal(actual: unknown, expected: unknown, message?: string): void;
    throws(
      fn: () => unknown,
      expected?: RegExp | ((error: unknown) => boolean),
      message?: string,
    ): void;
  }
  const assert: Assert;
  export default assert;
}
