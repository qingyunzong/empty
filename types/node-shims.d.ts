// Minimal type declarations for the Node.js built-in modules used by this
// project, so the codebase stays dependency-free (no @types/node required).

declare module "node:test" {
  type TestFn = () => void | Promise<void>;
  export function test(name: string, fn: TestFn): void;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: TestFn): void;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): asserts value;
  export function match(value: string, regExp: RegExp, message?: string): void;
  export function throws(fn: () => unknown, message?: string): void;
}

declare module "node:process" {
  export const argv: string[];
  export function exit(code?: number): never;
}

declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};
