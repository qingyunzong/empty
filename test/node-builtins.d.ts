declare module "node:assert/strict" {
  interface Assert {
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    notDeepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): asserts value;
    throws(
      block: () => unknown,
      error?: RegExp | ((error: unknown) => boolean),
      message?: string,
    ): void;
  }

  const assert: Assert;
  export default assert;
}

declare module "node:test" {
  interface TestContext {
    name?: string;
  }

  function test(
    name: string,
    fn: (context: TestContext) => void | Promise<void>,
  ): void;

  export default test;
}
