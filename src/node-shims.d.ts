// Minimal ambient declarations for the Node.js built-in modules used by the
// tests, so the project compiles without downloading @types/node.
declare module 'node:test' {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
}

declare module 'node:assert/strict' {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): asserts value;
  export function throws(fn: () => unknown, matcher?: RegExp | ((err: unknown) => boolean), message?: string): void;
}

declare const console: {
  log(...args: unknown[]): void;
};
