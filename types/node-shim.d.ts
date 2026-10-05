// 最小化的 Node.js 内置模块类型声明（环境无法安装 @types/node）。
// 仅声明本项目用到的 API；运行时全部来自 Node.js 内置库。
declare module "node:test" {
  type TestFn = () => void | Promise<void>;
  function test(name: string, fn: TestFn): void;
  namespace test {
    function skip(name: string, fn: TestFn): void;
  }
  export default test;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): asserts value;
  export function throws(fn: () => unknown, expected?: RegExp | ((err: unknown) => boolean), message?: string): void;
}
