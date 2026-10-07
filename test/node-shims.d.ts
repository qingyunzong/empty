// Minimal ambient declarations for the Node built-ins used by the tests.
// (The sandbox has no network access to install @types/node.)
declare module 'node:assert/strict' {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function throws(fn: () => unknown, error?: unknown, message?: string): void;
  const assert: {
    equal: typeof equal;
    deepEqual: typeof deepEqual;
    ok: typeof ok;
    throws: typeof throws;
  };
  export default assert;
}

declare module 'node:test' {
  type TestFn = () => void | Promise<void>;
  function test(name: string, fn: TestFn): void;
  export default test;
}
