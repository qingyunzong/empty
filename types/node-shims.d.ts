// Minimal ambient declarations for the Node.js built-in modules used by this
// project (the environment has no @types/node and the network is restricted).
declare module "node:test" {
  export type TestFn = () => void | Promise<void>;
  export function test(name: string, fn: TestFn): void;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: TestFn): void;
  export default test;
}

declare module "node:assert/strict" {
  export function ok(value: unknown, message?: string): asserts value;
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function strictEqual(actual: unknown, expected: unknown, message?: string): void;
  export function notStrictEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepStrictEqual(actual: unknown, expected: unknown, message?: string): void;
  export function notDeepStrictEqual(actual: unknown, expected: unknown, message?: string): void;
  export function throws(fn: () => unknown, expected?: RegExp | ((err: unknown) => boolean), message?: string): void;
  export function doesNotThrow(fn: () => unknown, message?: string): void;
  export function fail(message?: string): never;
  const assert: typeof ok & {
    ok: typeof ok;
    equal: typeof equal;
    notEqual: typeof notEqual;
    strictEqual: typeof strictEqual;
    notStrictEqual: typeof notStrictEqual;
    deepEqual: typeof deepStrictEqual;
    notDeepEqual: typeof notDeepStrictEqual;
    deepStrictEqual: typeof deepStrictEqual;
    notDeepStrictEqual: typeof notDeepStrictEqual;
    throws: typeof throws;
    doesNotThrow: typeof doesNotThrow;
    fail: typeof fail;
  };
  export default assert;
}
