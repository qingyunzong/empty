// 最小化 Node.js 内置模块类型声明（仅覆盖本项目用到的 API，零外部依赖）。
declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): asserts value;
  export function throws(fn: () => unknown, matcher?: RegExp | ((err: unknown) => boolean), message?: string): void;
  const assert: {
    equal: typeof equal;
    deepEqual: typeof deepEqual;
    ok: typeof ok;
    throws: typeof throws;
  };
  export default assert;
}

declare module "node:test" {
  type TestFn = () => void | Promise<void>;
  export function test(name: string, fn: TestFn): void;
  export function describe(name: string, fn: () => void): void;
}

// 全局 console（node 内置全局对象）
declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};
