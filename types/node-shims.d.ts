// 离线环境最小声明：仅覆盖测试用到的 Node 内置模块 API
declare module 'node:test' {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => void | Promise<void>): void;
}

declare module 'node:assert/strict' {
  export function deepStrictEqual(actual: unknown, expected: unknown, message?: string): void;
  export function strictEqual(actual: unknown, expected: unknown, message?: string): void;
  export function notStrictEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function throws(fn: () => void, error?: unknown, message?: string): void;
}
