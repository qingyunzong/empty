// 离线环境无法安装 @types/node，这里只声明测试用到的最小 API 面。
declare module "node:test" {
  export type TestFn = () => void | Promise<void>;
  export function test(name: string, fn: TestFn): void;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: TestFn): void;
  const test: {
    (name: string, fn: TestFn): void;
    describe: typeof describe;
    it: typeof it;
  };
  export default test;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): asserts value;
  export function throws(fn: () => unknown, expected?: RegExp | (new (...args: never[]) => Error), message?: string): void;
  export function doesNotThrow(fn: () => unknown, message?: string): void;
}
