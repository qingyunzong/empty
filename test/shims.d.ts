// Minimal type shims for Node built-in modules used in tests, so the
// project compiles without @types/node (runtime uses Node built-ins only).
declare module "node:test" {
  export function test(
    name: string,
    fn: () => void | Promise<void>,
  ): void;
  export default test;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
}
