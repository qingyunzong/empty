declare module "node:test" {
  type TestFunction = () => void | Promise<void>;
  function test(name: string, fn: TestFunction): void;
  export default test;
}

declare module "node:assert/strict" {
  interface Assert {
    (value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    throws(
      block: () => unknown,
      expected?: RegExp | ((error: unknown) => boolean) | unknown,
      message?: string,
    ): void;
  }
  const assert: Assert;
  export default assert;
}
