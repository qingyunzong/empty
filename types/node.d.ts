// Minimal ambient declarations for the Node.js built-ins this project uses.
// The project has no npm dependencies, so these stand in for @types/node.

declare module 'node:test' {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module 'node:assert/strict' {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function rejects(
    promise: Promise<unknown>,
    matcher?: unknown,
    message?: string,
  ): Promise<void>;
}

declare module 'node:async_hooks' {
  export class AsyncLocalStorage<T> {
    getStore(): T | undefined;
    run<R>(store: T, callback: () => R): R;
  }
}

declare function setImmediate(callback: () => void): unknown;
