// Minimal ambient declarations for the Node.js built-in modules used by the
// tests. The environment has no @types/node and no network access, so we
// declare just the surface we rely on (Node.js built-in libraries only).

declare module "node:test" {
  type TestFn = () => void | Promise<void>;
  interface TestContext {
    readonly name: string;
  }
  export function test(name: string, fn: TestFn): void;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: TestFn): void;
  export default test;
}

declare module "node:assert/strict" {
  export function ok(value: unknown, message?: string): asserts value;
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function throws(fn: () => unknown, error?: RegExp | (new (...args: never[]) => Error) | ((err: unknown) => boolean), message?: string): void;
  export function doesNotThrow(fn: () => unknown, message?: string): void;
  export function fail(message?: string): never;
}

interface Console {
  log(...data: unknown[]): void;
  error(...data: unknown[]): void;
}
declare var console: Console;
