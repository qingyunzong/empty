// Minimal ambient declarations for the Node.js built-in modules used by the
// tests. The environment has no network access to install @types/node, so
// only the exercised surface is declared here.
declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): asserts value;
  export function fail(message?: string): never;
  export function throws(fn: () => void, expected?: RegExp | ((err: unknown) => boolean) | (new (...args: never[]) => Error), message?: string): void;
}
