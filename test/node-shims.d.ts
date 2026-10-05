// 环境无 @types/node（离线），为 Node 内置模块提供最小类型声明。
declare module 'node:test' {
  type TestFn = () => void | Promise<void>;
  export function test(name: string, fn: TestFn): void;
  const testExport: { (name: string, fn: TestFn): void };
  export default testExport;
}

declare module 'node:assert/strict' {
  export function ok(value: unknown, message?: string): void;
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function rejects(
    promise: Promise<unknown>,
    validator?:
      | ((error: unknown) => boolean)
      | RegExp
      | (new (...args: never[]) => Error),
    message?: string,
  ): Promise<void>;
  const assert: {
    ok: typeof ok;
    equal: typeof equal;
    notEqual: typeof notEqual;
    deepEqual: typeof deepEqual;
    rejects: typeof rejects;
  };
  export default assert;
}
