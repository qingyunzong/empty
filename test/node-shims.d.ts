declare module 'node:test' {
  export function test(
    name: string,
    fn: () => void | Promise<void>,
  ): void;
  export function test(
    name: string,
    options: { skip?: boolean },
    fn: () => void | Promise<void>,
  ): void;
}

declare module 'node:assert/strict' {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepStrictEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): asserts value;
  export function fail(message?: string): never;
  export function throws(fn: () => unknown, expected?: RegExp | ((err: unknown) => boolean), message?: string): void;
  const assert: {
    equal: typeof equal;
    notEqual: typeof notEqual;
    deepEqual: typeof deepEqual;
    deepStrictEqual: typeof deepStrictEqual;
    ok: typeof ok;
    fail: typeof fail;
    throws: typeof throws;
  };
  export default assert;
}
