// Minimal ambient declarations for the Node test runner APIs used here.
// (The sandbox has no network access to install @types/node.)
declare module 'node:test' {
  type TestFn = () => void | Promise<void>;
  function test(name: string, fn: TestFn): void;
  export default test;
}

declare module 'node:assert/strict' {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function notDeepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): asserts value;
  export function throws(fn: () => unknown, expected?: unknown, message?: string): void;
}
