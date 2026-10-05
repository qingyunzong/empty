// Minimal ambient declarations for the Node.js built-ins used in tests.
// (Offline environment: @types/node is not installable.)
declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export default test;
}

declare module "node:assert/strict" {
  export function ok(value: unknown, message?: string): asserts value;
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function match(actual: string, expected: RegExp, message?: string): void;
  export function throws(
    fn: () => unknown,
    expected?: RegExp | (new (...args: never[]) => Error) | ((err: unknown) => boolean),
    message?: string,
  ): void;
  const assert: {
    ok: typeof ok;
    equal: typeof equal;
    deepEqual: typeof deepEqual;
    match: typeof match;
    throws: typeof throws;
  };
  export default assert;
}
