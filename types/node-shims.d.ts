// 最小化 Node 内置模块类型声明（项目零依赖，不安装 @types/node）。
declare module 'node:test' {
  export type TestFn = () => void | Promise<void>;
  export interface TestContext {
    diagnostic(msg: string): void;
  }
  export default function test(name: string, fn: (t: TestContext) => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: TestFn): void;
}

declare module 'node:assert/strict' {
  export function ok(value: unknown, message?: string): void;
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function throws(fn: () => unknown, message?: string): void;
}

declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};
