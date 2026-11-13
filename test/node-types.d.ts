declare module "node:assert/strict" {
  interface Assert {
    ok(value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    throws(
      function_: () => unknown,
      expected?: unknown,
      message?: string,
    ): void;
    rejects(
      promise: Promise<unknown>,
      expected?: unknown,
      message?: string,
    ): Promise<void>;
  }

  const assert: Assert;
  export default assert;
}

declare module "node:test" {
  interface TestOptions {
    skip?: boolean;
    only?: boolean;
    todo?: boolean;
  }

  type TestFunction = () => void | Promise<void>;

  function test(name: string, function_: TestFunction): void;
  function test(
    name: string,
    options: TestOptions,
    function_: TestFunction,
  ): void;

  export default test;
}
