// Minimal ambient declarations for the Node.js built-in modules used by the
// tests. The environment has no network access, so @types/node cannot be
// installed; these cover exactly the APIs exercised by this project.

declare module 'node:test' {
  export interface TestContext {
    name: string;
  }
  export type TestFn = (t: TestContext) => void | Promise<void>;
  export function test(name: string, fn: TestFn): void;
  export function describe(name: string, fn: () => void): void;
  export default test;
}

declare module 'node:assert/strict' {
  export function ok(value: unknown, message?: string): asserts value;
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function notDeepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function throws(fn: () => unknown, message?: string): void;
  export function fail(message?: string): never;
}
