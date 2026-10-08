// Minimal ambient declarations for the Node.js built-in modules used by the
// tests, so the project typechecks without installing @types/node.
declare module "node:test" {
  export type TestFn = () => void | Promise<void>;
  export function test(name: string, fn: TestFn): void;
  export function describe(name: string, fn: () => void): void;
  export default test;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): asserts value;
  export function match(actual: string, regexp: RegExp, message?: string): void;
  export function throws(fn: () => unknown, message?: string): void;
  interface Assert {
    (value: unknown, message?: string): asserts value;
    equal: typeof equal;
    deepEqual: typeof deepEqual;
    ok: typeof ok;
    match: typeof match;
    throws: typeof throws;
  }
  const assert: Assert;
  export default assert;
}
