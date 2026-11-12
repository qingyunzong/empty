declare const console: {
  log(...values: unknown[]): void;
};

declare module "node:test" {
  export function test(
    name: string,
    fn: () => void | Promise<void>,
  ): void;
}

declare module "node:assert/strict" {
  interface Assert {
    (value: unknown, message?: string): asserts value;
    deepStrictEqual(actual: unknown, expected: unknown, message?: string): void;
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): asserts value;
    fail(message?: string): never;
    strictEqual(actual: unknown, expected: unknown, message?: string): void;
    throws(fn: () => unknown, expected?: unknown, message?: string): void;
    rejects(
      fn: () => Promise<unknown>,
      expected?: unknown,
      message?: string,
    ): Promise<void>;
  }
  const assert: Assert;
  export default assert;
}
