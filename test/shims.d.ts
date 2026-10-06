declare module "node:test" {
  type TestBody = () => void | Promise<void>;
  interface Test {
    (name: string, fn: TestBody): void;
    skip(name: string, fn: TestBody): void;
    todo(name: string, fn?: TestBody): void;
  }
  const test: Test;
  export default test;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: TestBody): void;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): asserts value;
  export function throws(
    fn: () => unknown,
    expected?: RegExp | ((err: unknown) => boolean),
    message?: string,
  ): void;
  const assert: {
    equal: typeof equal;
    notEqual: typeof notEqual;
    deepEqual: typeof deepEqual;
    ok: typeof ok;
    throws: typeof throws;
  };
  export default assert;
}
