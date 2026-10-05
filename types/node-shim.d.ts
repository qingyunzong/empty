// Minimal local type shims for the Node.js built-in test runner and strict
// assertions, covering only the surface this project uses. The environment
// has no @types/node package available.
declare module "node:test" {
  type TestFn = () => void | Promise<void>;
  function test(name: string, fn: TestFn): void;
  export default test;
}

declare module "node:assert/strict" {
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function throws(fn: () => unknown, pattern?: RegExp, message?: string): void;
  export function fail(message?: string): never;
}
