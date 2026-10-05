// Minimal ambient declarations for the Node.js built-in modules used by this
// project (node:test, node:assert). The library itself depends on no packages;
// these declarations exist so `tsc` can type-check without @types/node.
declare module "node:test" {
  export type TestFn = () => void | Promise<void>;
  export function test(name: string, fn: TestFn): void;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: TestFn): void;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function notDeepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): asserts value;
  export function fail(message?: string): never;
  export function throws(fn: () => unknown, message?: string): void;
  export function match(value: string, pattern: RegExp, message?: string): void;
}

declare const console: {
  log(...args: unknown[]): void;
};
