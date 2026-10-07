declare module "node:test" {
  export interface TestContext {
    test(name: string, fn: () => void | Promise<void>): void;
  }
  type TestBody = (t: TestContext) => void | Promise<void>;
  interface TestFn {
    (name: string, fn: TestBody): void;
    skip(name: string, fn: TestBody): void;
  }
  const test: TestFn;
  export default test;
}

declare module "node:assert/strict" {
  export function ok(value: unknown, message?: string): void;
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function throws(fn: () => unknown, error?: RegExp | ((err: unknown) => boolean), message?: string): void;
  export function match(actual: string, regexp: RegExp, message?: string): void;
}
