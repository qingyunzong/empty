// Minimal ambient declarations for the Node.js built-in modules used by this
// project, so the library stays dependency-free (no @types/node required).
declare module "node:test" {
  export type TestFn = () => void | Promise<void>;
  export function test(name: string, fn: TestFn): void;
  export function describe(name: string, fn: () => void): void;
}

declare module "node:assert" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): asserts value;
  export function fail(message?: string): never;
  const assert: {
    equal: typeof equal;
    deepEqual: typeof deepEqual;
    ok: typeof ok;
    fail: typeof fail;
  };
  export default assert;
}
