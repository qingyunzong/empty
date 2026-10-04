// 最小 Node 内置模块类型声明（仅覆盖本项目用到的 API），
// 使 tsc 在零依赖环境下完成类型检查。
declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module "node:assert/strict" {
  interface Assert {
    (value: unknown, message?: string): void;
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    throws(fn: () => unknown, error?: unknown, message?: string): void;
  }
  const assert: Assert;
  export default assert;
}

declare const console: {
  log(...args: unknown[]): void;
};
