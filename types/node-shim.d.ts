// Minimal ambient declarations for the Node.js built-in modules used by the
// tests. The environment has no network access to install @types/node, so
// only the exercised surface is declared here.
declare module "node:test" {
  export type TestFn = () => void | Promise<void>;
  export function test(name: string, fn: TestFn): void;
  export function test(name: string, options: Record<string, unknown>, fn: TestFn): void;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): asserts value;
  export function throws(fn: () => unknown, error?: unknown, message?: string): void;
  export function doesNotThrow(fn: () => unknown, message?: string): void;
  const assert: {
    equal: typeof equal;
    notEqual: typeof notEqual;
    deepEqual: typeof deepEqual;
    ok: typeof ok;
    throws: typeof throws;
    doesNotThrow: typeof doesNotThrow;
  };
  export default assert;
}
