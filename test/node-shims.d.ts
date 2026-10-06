// Minimal ambient declarations so the offline toolchain can type-check
// tests that use node:test and node:assert/strict (no @types/node available).
declare module "node:test" {
  export type TestFn = () => void | Promise<void>;
  export function test(name: string, fn: TestFn): void;
  export function describe(name: string, fn: () => void): void;
  export default test;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): asserts value;
  export function throws(
    fn: () => unknown,
    expected?:
      | RegExp
      | ((err: unknown) => boolean)
      | (new (...args: never[]) => Error),
    message?: string,
  ): void;
  export function match(actual: string, regexp: RegExp, message?: string): void;
}
