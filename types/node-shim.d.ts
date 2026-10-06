declare module "node:test" {
  type TestFn = () => void | Promise<void>;
  interface TestOptions {
    timeout?: number;
  }
  export function test(name: string, fn: TestFn): void;
  export function test(name: string, options: TestOptions, fn: TestFn): void;
  export function describe(name: string, fn: () => void): void;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function rejects(
    promise: Promise<unknown> | (() => Promise<unknown>),
    error?: unknown,
    message?: string,
  ): Promise<void>;
}

declare function setTimeout(callback: () => void, ms?: number): unknown;
