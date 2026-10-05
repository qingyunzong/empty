// 离线环境下的最小 Node 内置模块类型声明（仅覆盖本仓库用到的 API）。
// 有网络时可替换为官方 @types/node。
declare module "node:test" {
  export interface TestContext {
    diagnostic(message: string): void;
  }
  export type TestFn = (t: TestContext) => void | Promise<void>;
  export function test(name: string, fn: TestFn): void;
  export function test(name: string, options: Record<string, unknown>, fn: TestFn): void;
}

declare module "node:assert/strict" {
  interface Assert {
    (value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): asserts value;
    throws(fn: () => unknown, message?: string): void;
  }
  const assert: Assert;
  export default assert;
}
