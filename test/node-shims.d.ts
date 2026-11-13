declare module "node:test" {
  export function test(
    name: string,
    fn: () => void | Promise<void>,
  ): void;
  export default test;
}

declare module "node:assert/strict" {
  interface Assert {
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    throws(
      block: () => unknown,
      error?: new (...args: never[]) => Error,
      message?: string,
    ): void;
  }
  const assert: Assert;
  export default assert;
}
