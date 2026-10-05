// Minimal ambient declarations so `tsc --noEmit` works without @types/node.
// Runtime only uses Node.js built-in modules.
declare module 'node:test' {
  export type TestFn = () => void | Promise<void>;
  export function test(name: string, fn: TestFn): void;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: TestFn): void;
  export default test;
}

declare module 'node:assert/strict' {
  export function ok(value: unknown, message?: string): void;
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function match(actual: string, regExp: RegExp, message?: string): void;
  export function throws(fn: () => unknown, expected?: RegExp, message?: string): void;
  export function fail(message?: string): never;
}

declare function structuredClone<T>(value: T): T;

declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};
