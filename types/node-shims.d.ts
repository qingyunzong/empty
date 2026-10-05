// Minimal ambient declarations for the Node.js built-in modules used by the
// tests, because @types/node is not installable in this offline environment.
// Only the surface actually used by this project is declared.

declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function test(name: string, options: { skip?: boolean }, fn: () => void | Promise<void>): void;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): asserts value;
  export function throws(fn: () => unknown, error?: RegExp | (new (...args: never[]) => Error), message?: string): void;
  const assert: {
    equal: typeof equal;
    deepEqual: typeof deepEqual;
    ok: typeof ok;
    throws: typeof throws;
  };
  export default assert;
}
