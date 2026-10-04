// 最小 Node 内置模块类型声明（不安装任何 npm 依赖，含 @types/node）。
declare module 'node:test' {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => void | Promise<void>): void;
}
declare module 'node:assert/strict' {
  export function equal(a: unknown, b: unknown, msg?: string): void;
  export function notEqual(a: unknown, b: unknown, msg?: string): void;
  export function deepEqual(a: unknown, b: unknown, msg?: string): void;
  export function ok(v: unknown, msg?: string): void;
  export function fail(msg?: string): never;
  export function throws(fn: () => void, msg?: string): void;
}
declare module 'node:crypto' {
  export function createHash(alg: string): {
    update(data: string): { digest(enc: 'hex'): string };
  };
}
declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};
declare const process: {
  argv: string[];
  exitCode?: number;
};
