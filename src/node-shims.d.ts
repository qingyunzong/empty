// Minimal ambient declarations for the Node.js built-in modules used here.
// The project has zero npm dependencies, so @types/node is not available;
// only the small surface we actually use is declared.
declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function throws(fn: () => unknown, message?: string): void;
}

declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare const console: {
  log(...args: unknown[]): void;
};
