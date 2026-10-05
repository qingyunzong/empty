// 仅声明本库用到的 Node 内置模块最小接口，避免依赖 @types/node（离线环境）。
declare module "node:test" {
  type TestFn = () => void | Promise<void>;
  export function test(name: string, fn: TestFn): void;
}

declare module "node:assert/strict" {
  interface Assert {
    (value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    throws(fn: () => unknown, expected?: RegExp, message?: string): void;
  }
  const assert: Assert;
  export = assert;
}
