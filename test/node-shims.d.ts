// 最小化的 Node 内置模块类型声明（环境无 @types/node，网络受限无法安装）。
declare function setTimeout(callback: () => void, ms: number): unknown;

declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module "node:assert/strict" {
  type AssertCheck = RegExp | ((err: any) => boolean) | (new (...args: never[]) => Error);
  interface Assert {
    ok(value: unknown, message?: string): void;
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    throws(fn: () => unknown, check?: AssertCheck): void;
    rejects(promise: Promise<unknown>, check?: AssertCheck): Promise<void>;
  }
  const assert: Assert;
  export default assert;
}
