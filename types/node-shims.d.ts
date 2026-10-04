// 最小 Node.js 内置模块类型声明（环境离线，无法安装 @types/node）。
interface Buffer extends Uint8Array {
  toString(encoding?: string): string;
  subarray(begin?: number, end?: number): Buffer;
}
declare var Buffer: {
  from(data: number[] | Uint8Array | string, encoding?: string): Buffer;
  concat(list: Uint8Array[]): Buffer;
};

declare module "node:test" {
  export type TestFn = () => void | Promise<void>;
  export function test(name: string, fn: TestFn): void;
  export function describe(name: string, fn: () => void): void;
}

declare module "node:assert/strict" {
  export function deepStrictEqual(actual: unknown, expected: unknown, message?: string): void;
  export function strictEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  const assert: {
    deepStrictEqual: typeof deepStrictEqual;
    strictEqual: typeof strictEqual;
    ok: typeof ok;
  };
  export default assert;
}
