// 环境无 @types/node，为测试所用的最小 API 提供类型声明。
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
  export function throws(
    fn: () => unknown,
    expected?: RegExp | ((err: unknown) => boolean) | Record<string, unknown>,
    message?: string,
  ): void;
  export function fail(message?: string): never;
  const assert: {
    deepStrictEqual: typeof deepStrictEqual;
    strictEqual: typeof strictEqual;
    notStrictEqual: typeof notStrictEqual;
    ok: typeof ok;
    throws: typeof throws;
    fail: typeof fail;
  };
  export default assert;
}
