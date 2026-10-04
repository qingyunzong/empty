// Minimal type declarations for the Node.js built-ins used by this project.
// The environment has no @types/node and no network access, so only the
// small surface we actually use is declared here.

declare module 'node:test' {
  export type TestFn = () => void | Promise<void>;
  export function test(name: string, fn: TestFn): void;
  export default test;
}

declare module 'node:assert/strict' {
  export function ok(value: unknown, message?: string): asserts value;
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function rejects(
    promise: Promise<unknown>,
    matcher?: { name?: string; message?: string | RegExp } | RegExp,
    message?: string,
  ): Promise<void>;
  export function fail(message?: string): never;
}

declare function setImmediate(callback: (...args: never[]) => void): unknown;
