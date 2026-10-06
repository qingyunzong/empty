// 离线环境下的最小 Node 类型声明（仅覆盖测试用到的 API）。
declare module "node:test" {
  export type TestFn = () => void | Promise<void>;
  export default function test(name: string, fn: TestFn): void;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): asserts value;
  export function match(actual: string, regexp: RegExp, message?: string): void;
  export function throws(
    fn: () => unknown,
    error?: (new (...args: never[]) => unknown) | ((err: unknown) => boolean),
    message?: string,
  ): void;
}
