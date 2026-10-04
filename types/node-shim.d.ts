// 离线环境下的最小 Node 内置模块类型声明（仅覆盖本仓库用到的 API）。
// 若安装了 @types/node，可删除本文件。
declare module 'node:test' {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module 'node:assert/strict' {
  interface Assert {
    (value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    throws(fn: () => unknown, error?: unknown, message?: string): void;
  }
  const assert: Assert;
  export default assert;
}
