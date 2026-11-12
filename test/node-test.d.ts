declare module "node:test" {
  export function test(
    name: string,
    fn: () => void | Promise<void>,
  ): void;
}

declare module "node:assert/strict" {
  interface AssertStrict {
    (value: unknown, message?: string | Error): asserts value;
    equal(actual: unknown, expected: unknown, message?: string | Error): void;
    notEqual(
      actual: unknown,
      expected: unknown,
      message?: string | Error,
    ): void;
    deepEqual(
      actual: unknown,
      expected: unknown,
      message?: string | Error,
    ): void;
    strictEqual(
      actual: unknown,
      expected: unknown,
      message?: string | Error,
    ): void;
    throws(
      fn: () => unknown,
      error?:
        | RegExp
        | Function
        | { name?: string; message?: string | RegExp },
      message?: string | Error,
    ): void;
    rejects(
      fn: () => Promise<unknown> | unknown,
      error?: unknown,
    ): Promise<void>;
    ok(value: unknown, message?: string | Error): void;
    fail(message?: string | Error): never;
  }
  const assert: AssertStrict;
  export default assert;
}
