// Minimal ambient declarations for the Node.js built-in modules used by the
// tests. The environment has no network access, so @types/node cannot be
// installed; only the members actually used are declared here.
declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): unknown;
  export function describe(name: string, fn: () => void): unknown;
  export function it(name: string, fn: () => void | Promise<void>): unknown;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function notDeepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function throws(fn: () => unknown, expected?: RegExp | ((err: unknown) => boolean), message?: string): void;
  export function match(actual: string, expected: RegExp, message?: string): void;
}
