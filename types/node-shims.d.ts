// 最小化的 Node.js 内置模块类型声明（环境无 @types/node，且项目零依赖）。
declare module "node:test" {
  export type TestFn = () => void | Promise<void>;
  export function test(name: string, fn: TestFn): void;
}

declare module "node:assert/strict" {
  export function ok(value: unknown, message?: string): asserts value;
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function throws(fn: () => unknown, message?: string | RegExp): void;
  export function rejects(
    promise: Promise<unknown> | (() => Promise<unknown>),
    message?: string | RegExp
  ): Promise<void>;
}

declare function setTimeout(callback: () => void, ms?: number): unknown;
