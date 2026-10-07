// Minimal type declarations for the Node built-ins used by the tests
// (the sandbox has no @types/node and no network access).
declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function match(value: string, regExp: RegExp, message?: string): void;
  export function throws(fn: () => unknown, expected?: RegExp | (new (...args: never[]) => Error), message?: string): void;
  const assert: {
    equal: typeof equal;
    deepEqual: typeof deepEqual;
    ok: typeof ok;
    match: typeof match;
    throws: typeof throws;
  };
  export default assert;
}
