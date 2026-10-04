// Minimal ambient declarations for the Node.js built-ins used by the tests.
// The project has no npm dependencies, so @types/node is not installed.

declare module "node:test" {
  export type TestFn = () => void | Promise<void>;
  export function test(name: string, fn: TestFn): void;
  export default test;
}

declare module "node:assert/strict" {
  export function ok(value: unknown, message?: string): asserts value;
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function throws(
    fn: () => unknown,
    matcher?: RegExp | ((err: unknown) => boolean),
    message?: string,
  ): void;
  export function rejects(
    promise: Promise<unknown> | (() => Promise<unknown>),
    matcher?: RegExp | ((err: unknown) => boolean),
    message?: string,
  ): Promise<void>;
  export function fail(message?: string): never;
}

declare function setImmediate(callback: (...args: any[]) => void): unknown;
