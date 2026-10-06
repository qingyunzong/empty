/*
 * Minimal offline type shims for the Node built-ins used by the tests.
 * The sandbox has no registry access, so @types/node cannot be installed;
 * replace this file with the real typings when they are available.
 */
declare module 'node:assert/strict' {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function throws(fn: () => unknown, error?: unknown, message?: string): void;
  const assert: {
    equal: typeof equal;
    notEqual: typeof notEqual;
    deepEqual: typeof deepEqual;
    ok: typeof ok;
    throws: typeof throws;
  };
  export default assert;
}

declare module 'node:test' {
  type TestFn = () => void | Promise<void>;
  interface Test {
    (name: string, fn: TestFn): void;
  }
  const test: Test;
  export default test;
}
