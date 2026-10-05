// 本环境无网络、无法安装 @types/node；此处声明用到的最小 Node 内置 API。
declare const console: {
  log(...args: unknown[]): void;
};
declare const process: {
  hrtime: { bigint(): bigint };
};
declare module "node:test" {
  export function test(name: string, fn: () => void): void;
}
declare module "node:assert/strict" {
  export function equal(a: unknown, b: unknown, msg?: string): void;
  export function deepEqual(a: unknown, b: unknown, msg?: string): void;
  export function ok(v: unknown, msg?: string): void;
  export function throws(fn: () => void, msg?: string): void;
}
