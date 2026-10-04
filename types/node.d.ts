// 网络受限环境下 @types/node 不可用，这里只声明本项目用到的 Node.js 内置 API。
declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module "node:assert/strict" {
  interface Assert {
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    rejects(
      promise: Promise<unknown>,
      validator?: (error: unknown) => boolean,
    ): Promise<void>;
  }
  const assert: Assert;
  export default assert;
}

declare function setImmediate(callback: () => void): unknown;
declare function queueMicrotask(callback: () => void): void;
