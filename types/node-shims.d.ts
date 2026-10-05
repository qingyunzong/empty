/** 最小化的 Node 内置模块类型声明（运行时仅使用 Node 内置库）。 */
declare module "node:test" {
  type TestFn = () => void | Promise<void>;
  export function test(name: string, fn: TestFn): void;
  export function describe(name: string, fn: () => void): void;
  export default test;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): asserts value;
  export function throws(
    fn: () => unknown,
    error?: RegExp | (new (...args: never[]) => Error) | ((err: unknown) => boolean),
    message?: string,
  ): void;
  export function doesNotThrow(fn: () => unknown, message?: string): void;
}
