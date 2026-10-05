// Minimal ambient declarations for the Node.js built-in modules used by this
// project, so `tsc --noEmit` works without installing @types/node.
declare module "node:test" {
  export type TestFn = () => void | Promise<void>;
  export function test(name: string, fn: TestFn): void;
  export function describe(name: string, fn: () => void): void;
  export default test;
}

declare module "node:assert/strict" {
  export function equal(a: unknown, b: unknown, msg?: string): void;
  export function notEqual(a: unknown, b: unknown, msg?: string): void;
  export function deepEqual(a: unknown, b: unknown, msg?: string): void;
  export function notDeepEqual(a: unknown, b: unknown, msg?: string): void;
  export function ok(value: unknown, msg?: string): asserts value;
  export function fail(msg?: string): never;
  export function match(value: string, pattern: RegExp, msg?: string): void;
  export function throws(fn: () => unknown, matcher?: RegExp | ((e: unknown) => boolean), msg?: string): void;
  export function doesNotThrow(fn: () => unknown, msg?: string): void;
  const assert: {
    equal: typeof equal;
    notEqual: typeof notEqual;
    deepEqual: typeof deepEqual;
    notDeepEqual: typeof notDeepEqual;
    ok: typeof ok;
    fail: typeof fail;
    match: typeof match;
    throws: typeof throws;
    doesNotThrow: typeof doesNotThrow;
  };
  export default assert;
}
