/**
 * 离线环境下的 Node 内置模块最小声明，仅覆盖本仓库测试所需 API。
 */

declare module "node:test" {
  export type TestFn = (t: TestContext) => void | Promise<void>;

  export interface TestContext {
    readonly name: string;
    test(name: string, fn: TestFn): void | Promise<void>;
  }

  export function test(name: string, fn: TestFn): void;
  const testDefault: typeof test;
  export default testDefault;
}

declare module "node:assert/strict" {
  interface AssertStrict {
    (value: unknown, message?: string | Error): asserts value;
    equal(actual: unknown, expected: unknown, message?: string | Error): void;
    deepEqual(actual: unknown, expected: unknown, message?: string | Error): void;
    ok(value: unknown, message?: string | Error): void;
    throws(fn: () => unknown, error?: unknown, message?: string | Error): void;
  }

  const assert: AssertStrict;
  export default assert;
}
