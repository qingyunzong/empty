// 最小化的 Node 内置模块类型声明（环境无 @types/node，仅声明本仓库用到的 API）。
declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepStrictEqual(actual: unknown, expected: unknown, message?: string): void;
  const assert: {
    equal: typeof equal;
    deepEqual: typeof deepEqual;
    deepStrictEqual: typeof deepStrictEqual;
  };
  export default assert;
}
