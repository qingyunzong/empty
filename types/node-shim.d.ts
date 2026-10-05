declare module "node:test" {
  type TestFn = () => void | Promise<void>;
  export function test(name: string, fn: TestFn): void;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: TestFn): void;
}

declare module "node:assert/strict" {
  interface Assert {
    (value: unknown, message?: string): void;
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    throws(
      fn: () => unknown,
      error?: RegExp | ((err: unknown) => boolean) | (new (...args: never[]) => Error),
      message?: string
    ): void;
  }
  const assert: Assert;
  export default assert;
}

declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};
