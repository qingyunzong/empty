// Minimal ambient declarations for the Node.js built-in modules used by the
// tests, so the project type-checks without external @types/node (offline env).
declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function throws(fn: () => unknown, error?: unknown, message?: string): void;
}
