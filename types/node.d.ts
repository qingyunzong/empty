// 本项目零依赖，未安装 @types/node；此处仅声明用到的 Node 内置 API 子集。
declare module "node:fs" {
  export function readFileSync(path: string | number, encoding: BufferEncoding): string;
}

declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): unknown;
}

declare module "node:assert/strict" {
  interface Assert {
    (value: unknown, message?: string): void;
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    throws(fn: () => unknown, error?: RegExp | Error, message?: string): void;
    match(value: string, regExp: RegExp, message?: string): void;
  }
  const assert: Assert;
  export default assert;
}

declare const process: {
  argv: string[];
};
