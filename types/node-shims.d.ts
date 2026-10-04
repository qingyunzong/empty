// Minimal ambient declarations for the Node.js built-in modules used by this
// package. The project intentionally depends only on Node built-ins at
// runtime, and @types/node is not installed to keep installs offline-friendly.

declare module "node:assert/strict" {
  export function ok(value: unknown, message?: string): asserts value;
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function throws(fn: () => unknown, expected?: RegExp | ((err: unknown) => boolean), message?: string): void;
  export function rejects(promise: Promise<unknown>, expected?: RegExp | ((err: unknown) => boolean), message?: string): Promise<void>;
  export function fail(message?: string): never;
  export function match(value: string, regExp: RegExp, message?: string): void;
}

declare module "node:test" {
  type TestFn = () => void | Promise<void>;
  export function test(name: string, fn: TestFn): void;
  export function describe(name: string, fn: () => void): void;
  export default test;
}

declare module "node:async_hooks" {
  export class AsyncLocalStorage<T> {
    getStore(): T | undefined;
    run<R>(store: T, callback: (...args: unknown[]) => R, ...args: unknown[]): R;
    enterWith(store: T): void;
    disable(): void;
  }
}

declare function setTimeout(handler: (...args: unknown[]) => void, timeout?: number, ...args: unknown[]): unknown;
declare function clearTimeout(handle: unknown): void;
declare function setImmediate(handler: (...args: unknown[]) => void, ...args: unknown[]): unknown;

declare const process: {
  nextTick(callback: (...args: unknown[]) => void, ...args: unknown[]): void;
};
