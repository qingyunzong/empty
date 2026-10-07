declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
}

declare module "node:assert/strict" {
  export function ok(value: unknown, message?: string): void;
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function strictEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function match(actual: string, regexp: RegExp, message?: string): void;
}
