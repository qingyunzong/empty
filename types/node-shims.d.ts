declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export default test;
}

declare module "node:assert/strict" {
  export function deepStrictEqual(actual: unknown, expected: unknown, message?: string): void;
  export function strictEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): asserts value;
  export function match(value: string, regExp: RegExp, message?: string): void;
  export function throws(
    fn: () => unknown,
    error?: RegExp | ((err: Error) => boolean) | Record<string, unknown>,
    message?: string
  ): void;
  export function fail(message?: string): never;
  const assert: {
    deepStrictEqual: typeof deepStrictEqual;
    strictEqual: typeof strictEqual;
    equal: typeof strictEqual;
    ok: typeof ok;
    match: typeof match;
    throws: typeof throws;
    fail: typeof fail;
  };
  export default assert;
}
