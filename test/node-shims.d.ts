// Minimal ambient declarations for the Node.js built-in modules used by the
// tests. The environment has no @types/node and no network access, so only
// the surface we actually use is declared here.
declare module 'node:test' {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => void | Promise<void>): void;
}

declare module 'node:assert/strict' {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function match(actual: string, regexp: RegExp, message?: string): void;
  export function throws(fn: () => unknown, expected?: RegExp | ((error: unknown) => boolean), message?: string): void;
}
