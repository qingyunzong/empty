// 最小 Node.js 内置模块类型声明（环境无 @types/node，仅覆盖本项目用到的 API）。
declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
}

declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function throws(fn: () => void, error?: unknown, message?: string): void;
  const assert: {
    equal: typeof equal;
    deepEqual: typeof deepEqual;
    throws: typeof throws;
  };
  export default assert;
}

declare const process: {
  argv: string[];
  exitCode: number | undefined;
};
