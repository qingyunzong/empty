declare module "node:test" {
  export type TestFn = () => void | Promise<void>;
  export function test(name: string, fn: TestFn): void;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: TestFn): void;
}

declare module "node:assert/strict" {
  export function ok(value: unknown, message?: string): asserts value;
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function rejects(
    promise: Promise<unknown>,
    matcher?: RegExp | ((error: unknown) => boolean),
    message?: string
  ): Promise<void>;
  export function throws(fn: () => unknown, matcher?: RegExp | ((error: unknown) => boolean), message?: string): void;
  export function fail(message?: string): never;
  const assert: {
    ok: typeof ok;
    equal: typeof equal;
    deepEqual: typeof deepEqual;
    rejects: typeof rejects;
    throws: typeof throws;
    fail: typeof fail;
  };
  export default assert;
}
