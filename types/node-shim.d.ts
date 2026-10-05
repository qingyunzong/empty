// Minimal type shims for Node.js built-in modules used by tests.
// The sandbox has no network access, so @types/node cannot be installed;
// only the small surface we actually use is declared here.
declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): asserts value;
  export function fail(message?: string): never;
  export function throws(fn: () => unknown, message?: string): void;
}

declare function structuredClone<T>(value: T): T;
