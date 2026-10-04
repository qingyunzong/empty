/**
 * Minimal ambient declarations for the Node.js built-in modules used by
 * the tests. The environment has no registry access, so instead of the
 * @types/node package we declare exactly the surface we rely on.
 * Runtime uses only Node.js built-ins (node:test, node:assert).
 */
declare module 'node:test' {
  export type TestFn = () => void | Promise<void>;
  export function test(name: string, fn: TestFn): void;
  export function test(fn: TestFn): void;
}

declare module 'node:assert/strict' {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): asserts value;
  const assert: {
    equal: typeof equal;
    deepEqual: typeof deepEqual;
    ok: typeof ok;
  };
  export default assert;
}
