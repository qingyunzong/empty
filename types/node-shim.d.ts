// 环境无网络、无法安装 @types/node 时的最小 Node.js 内置库类型声明。
declare module "node:fs" {
  export function readFileSync(path: string | number, encoding: "utf8"): string;
}
declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
}
declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function throws(fn: () => void, pattern?: RegExp, message?: string): void;
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
