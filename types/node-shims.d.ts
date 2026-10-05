// 最小化的 Node 内置模块类型声明。
// 本库运行时只依赖 Node 内置模块；离线环境没有 @types/node，
// 这里仅为 tsc --noEmit 提供测试用到的少量 API 类型。

declare module "node:test" {
  export type TestFn = () => void | Promise<void>;
  export function test(name: string, fn: TestFn): unknown;
  export function describe(name: string, fn: () => void): unknown;
  export function it(name: string, fn: TestFn): unknown;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function throws(fn: () => unknown, expected?: unknown, message?: string): void;
  const assert: {
    equal: typeof equal;
    notEqual: typeof notEqual;
    deepEqual: typeof deepEqual;
    ok: typeof ok;
    throws: typeof throws;
  };
  export default assert;
}
