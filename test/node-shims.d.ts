// Minimal ambient declarations for the Node built-ins used by the tests.
// The sandbox has no network access, so @types/node cannot be installed.
declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  const assert: {
    equal: typeof equal;
    deepEqual: typeof deepEqual;
    ok: typeof ok;
  };
  export default assert;
}

declare function setTimeout(callback: () => void, ms?: number): void;
