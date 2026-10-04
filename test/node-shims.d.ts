// 离线环境无 @types/node，此处为测试用到的 Node 内置模块子集提供最小类型声明。
declare module 'node:assert/strict' {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  const assert: {
    equal: typeof equal;
    deepEqual: typeof deepEqual;
    ok: typeof ok;
  };
  export default assert;
}

declare module 'node:test' {
  type TestFn = () => void | Promise<void>;
  function test(name: string, fn: TestFn): void;
  export default test;
}
