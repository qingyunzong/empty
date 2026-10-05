// 最小 Node.js 内置 API 类型声明（环境离线，无法安装 @types/node）。
// 仅覆盖本项目用到的 node: 内置库接口。

declare var console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

declare var process: {
  exitCode?: number;
  argv: string[];
};

declare module "node:test" {
  type TestFn = () => void | Promise<void>;
  export function test(name: string, fn: TestFn): void;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: TestFn): void;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function throws(
    fn: () => unknown,
    matcher?: RegExp | ((err: unknown) => boolean) | (new (...args: never[]) => unknown),
    message?: string,
  ): void;
  export function doesNotThrow(fn: () => unknown, message?: string): void;
}
