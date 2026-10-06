// Minimal offline type shims for the Node built-ins used by the tests
// (the sandbox has no network access to install @types/node).
declare module 'node:test' {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module 'node:assert/strict' {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function throws(fn: () => void, error?: unknown, message?: string): void;
  export function doesNotThrow(fn: () => void, message?: string): void;
  const assert: {
    equal: typeof equal;
    deepEqual: typeof deepEqual;
    ok: typeof ok;
    throws: typeof throws;
    doesNotThrow: typeof doesNotThrow;
  };
  export default assert;
}
