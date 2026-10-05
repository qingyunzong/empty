// 无网络环境下无法安装 @types/node，这里为测试用到的 Node 内置模块提供极简环境声明。
declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export default test;
}

declare module "node:assert/strict" {
  export function ok(value: unknown, message?: string): asserts value;
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function throws(
    fn: () => unknown,
    expected?: RegExp | (new (...args: never[]) => unknown) | ((err: unknown) => boolean),
    message?: string,
  ): void;
}
