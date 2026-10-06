// 离线环境下的最小 Node 类型声明（仅覆盖测试用到的 API）。
declare module "node:test" {
  type TestFn = () => void | Promise<void>;
  function test(name: string, fn: TestFn): void;
  export default test;
}

declare module "node:assert/strict" {
  function equal(actual: unknown, expected: unknown, message?: string): void;
  function throws(fn: () => unknown, error?: unknown, message?: string): void;
  const assert: {
    equal: typeof equal;
    throws: typeof throws;
  };
  export default assert;
}
