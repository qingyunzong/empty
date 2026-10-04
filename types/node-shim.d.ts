// Minimal ambient declarations for the Node.js built-in modules used by the
// tests. The environment has no network access, so @types/node cannot be
// installed; only the actually used surface is declared here.
declare module 'node:test' {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module 'node:assert/strict' {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function strictEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepStrictEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): asserts value;
  export function throws(fn: () => unknown, pattern?: RegExp, message?: string): void;
  const assert: {
    equal: typeof equal;
    strictEqual: typeof strictEqual;
    deepEqual: typeof deepEqual;
    deepStrictEqual: typeof deepStrictEqual;
    ok: typeof ok;
    throws: typeof throws;
  };
  export default assert;
}
