// 最小化的 node 内建模块类型声明（环境无 @types/node，npm test 离线可跑）。
declare module "node:test" {
  export function test(
    name: string,
    fn: () => void | Promise<void>,
  ): void;
  export default test;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function throws(fn: () => void, expected?: RegExp, message?: string): void;
}
