declare function setImmediate(callback: () => void): unknown;

declare module "node:test" {
  type TestFn = () => void | Promise<void>;
  export function test(name: string, fn: TestFn): void;
  export default test;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): asserts value;
  export function fail(message?: string): never;
  export function rejects(
    promise: Promise<unknown>,
    matcher?: RegExp | ((error: unknown) => boolean),
    message?: string,
  ): Promise<void>;
}
