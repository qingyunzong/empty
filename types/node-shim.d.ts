// Minimal ambient declarations for the Node.js built-in modules used by the
// tests, so the project type-checks without @types/node (offline environment).
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
  export function throws(
    fn: () => unknown,
    expected?: RegExp | (new (...args: never[]) => unknown) | ((err: unknown) => boolean),
    message?: string,
  ): void;
  export function fail(message?: string): never;
}
