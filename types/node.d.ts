declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export default test;
}
declare module "node:assert/strict" {
  export function ok(value: unknown, message?: string): void;
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function throws(fn: () => unknown, error?: RegExp | ((err: unknown) => boolean), message?: string): void;
  const assert: {
    ok: typeof ok;
    equal: typeof equal;
    notEqual: typeof notEqual;
    deepEqual: typeof deepEqual;
    throws: typeof throws;
  };
  export default assert;
}
