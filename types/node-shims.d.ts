/**
 * 环境无 @types/node 且无法联网安装，这里仅声明测试与编译实际用到的
 * node 内置模块最小类型面，供 tsc 类型检查使用（运行时仍由 Node 提供）。
 */

declare module 'node:test' {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module 'node:assert/strict' {
  interface StrictAssert {
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    deepStrictEqual(
      actual: unknown,
      expected: unknown,
      message?: string,
    ): void;
    ok(value: unknown, message?: string): void;
    throws(fn: () => unknown, error?: unknown): void;
    fail(message?: string): void;
  }
  const assert: StrictAssert;
  export default assert;
}
