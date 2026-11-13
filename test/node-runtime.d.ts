declare module "node:assert/strict" {
  interface Assert {
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): asserts value;
    throws(
      fn: () => unknown,
      expected?: RegExp | Error | (new (...args: never[]) => Error),
      message?: string,
    ): void;
  }

  const assert: Assert;
  export default assert;
}

declare module "node:test" {
  type TestFunction = () => void | Promise<void>;
  interface Test {
    (name: string, fn: TestFunction): void;
  }

  const test: Test;
  export default test;
}
