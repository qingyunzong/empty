declare module "node:test" {
  export function describe(
    name: string,
    fn: () => void | Promise<void>,
  ): void;
  export function it(name: string, fn: () => void | Promise<void>): void;
}

declare module "node:assert/strict" {
  interface Assert {
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    throws(fn: () => unknown, expected?: RegExp | Error, message?: string): void;
    rejects(
      promise: Promise<unknown>,
      expected?: RegExp | Error | ((error: unknown) => boolean),
      message?: string,
    ): Promise<void>;
  }

  const assert: Assert;
  export default assert;
}
