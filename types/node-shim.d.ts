// 仅声明本工程用到的 Node.js 内置 API（不依赖 @types/node）。
declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

declare const process: {
  argv: string[];
  exitCode: number;
  stdout: { write(text: string): void };
  stderr: { write(text: string): void };
};

declare module "node:fs" {
  export function readFileSync(path: string | number, encoding: "utf8"): string;
}

declare module "node:child_process" {
  export function execFileSync(
    file: string,
    args: string[],
    options?: { encoding: "utf8"; input?: string }
  ): string;
}

declare module "node:test" {
  export type TestFn = () => void | Promise<void>;
  export function test(name: string, fn: TestFn): void;
  export default test;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function match(actual: string, regexp: RegExp, message?: string): void;
  export function throws(fn: () => void, expected?: RegExp, message?: string): void;
}
