// 本环境离线，无法安装 @types/node；此处为项目实际用到的
// Node.js 内置模块（node:test / node:assert/strict）提供最小类型声明。
declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function throws(fn: () => unknown, error?: unknown, message?: string): void;
  const assert: {
    equal: typeof equal;
    deepEqual: typeof deepEqual;
    throws: typeof throws;
  };
  export default assert;
}
