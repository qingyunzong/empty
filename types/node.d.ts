// Minimal ambient declarations for the Node.js built-ins used by this
// project, so the codebase stays dependency-free (no @types/node install).

declare function setImmediate(callback: (...args: unknown[]) => void): unknown;

declare module 'node:assert/strict' {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): asserts value;
  export function throws(fn: () => unknown, message?: string): void;
}

declare module 'node:test' {
  type TestFn = () => void | Promise<void>;
  export function test(name: string, fn: TestFn): void;
}
