declare module "node:test" {
  export type TestFn = () => void | Promise<void>;
  export interface Test {
    (name: string, fn: TestFn): void;
  }
  const test: Test;
  export default test;
}

declare module "node:assert/strict" {
  export function equal(
    actual: unknown,
    expected: unknown,
    message?: string,
  ): void;
  export function deepEqual(
    actual: unknown,
    expected: unknown,
    message?: string,
  ): void;
  export function fail(message?: string): never;
}
