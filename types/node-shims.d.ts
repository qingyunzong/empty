// 离线环境无 @types/node，这里给出本项目用到的最小 Node 内置模块声明。
declare module "node:assert/strict" {
  export function equal(a: unknown, b: unknown, msg?: string): void;
  export function deepEqual(a: unknown, b: unknown, msg?: string): void;
  export function ok(v: unknown, msg?: string): asserts v;
  export function throws(fn: () => unknown, msg?: string): void;
}
declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
}
declare module "node:fs" {
  export function readFileSync(path: string, enc: string): string;
}
declare const process: {
  argv: string[];
  exitCode?: number;
  stdin: { on(ev: string, cb: (chunk?: unknown) => void): void };
};
declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};
declare class URL {
  constructor(url: string, base?: string);
  pathname: string;
}
interface ImportMeta {
  url: string;
}
