declare module "node:test" {
  export function test(
    name: string,
    fn: () => void | Promise<void>,
  ): void;
  export default test;
}

declare module "node:assert/strict" {
  interface Assert {
    (value: unknown, message?: string): asserts value;
    ok(value: unknown, message?: string): void;
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    strictEqual(actual: unknown, expected: unknown, message?: string): void;
    deepStrictEqual(actual: unknown, expected: unknown, message?: string): void;
    rejects(
      promise: Promise<unknown>,
      error?: RegExp | string | Error,
    ): Promise<void>;
  }
  const assert: Assert;
  export default assert;
}
