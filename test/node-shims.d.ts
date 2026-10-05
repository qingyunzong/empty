// 最小化的 Node 内置模块类型声明（环境无 @types/node，仅覆盖测试用到的 API）。
declare module 'node:test' {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
}

declare module 'node:assert/strict' {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): asserts value;
  export function rejects(
    fn: Promise<unknown> | (() => Promise<unknown>),
    matcher?: RegExp | (new (...args: never[]) => Error) | ((err: unknown) => boolean),
    message?: string
  ): Promise<void>;
  const assert: {
    equal: typeof equal;
    deepEqual: typeof deepEqual;
    ok: typeof ok;
    rejects: typeof rejects;
  };
  export default assert;
}

declare module 'node:timers/promises' {
  export function setTimeout(ms: number, value?: unknown): Promise<unknown>;
}
