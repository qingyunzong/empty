// 离线环境下的最小 node 类型声明（仅覆盖测试用到的 API）。
// 若可联网，建议 npm i -D @types/node 并删除本文件。
declare module 'node:test' {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module 'node:assert/strict' {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function throws(fn: () => unknown, pattern?: RegExp, message?: string): void;
  const assert: {
    equal: typeof equal;
    deepEqual: typeof deepEqual;
    ok: typeof ok;
    throws: typeof throws;
  };
  export default assert;
}
