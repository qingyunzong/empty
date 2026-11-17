declare module "node:test" {
  export function test(
    name: string,
    fn: () => void | Promise<void>,
  ): void;
  export function test(
    name: string,
    options: unknown,
    fn: () => void | Promise<void>,
  ): void;
}

declare module "node:assert/strict" {
  type ThrowsMatcher =
    | RegExp
    | Error
    | (new (...args: never[]) => Error)
    | ((error: unknown) => boolean);

  interface Assert {
    equal(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): asserts value;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    throws(fn: () => unknown, error?: ThrowsMatcher, message?: string): void;
    rejects(
      promise: PromiseLike<unknown>,
      error?: ThrowsMatcher,
      message?: string,
    ): Promise<void>;
  }

  const assert: Assert;
  export default assert;
}
