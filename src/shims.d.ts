// 本工程仅使用 Node.js 内置库；环境无 @types/node，以下为最小类型声明。
declare module "node:test" {
  export type TestFn = () => void | Promise<void>;
  export function test(name: string, fn: TestFn): void;
}

declare module "node:assert/strict" {
  export function ok(value: unknown, message?: string): void;
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function throws(fn: () => unknown, expected?: RegExp, message?: string): void;
}

declare module "node:fs" {
  export function readFileSync(path: string | number, encoding: "utf8"): string;
}

declare module "node:util" {
  export function parseArgs(config: {
    args?: string[];
    options?: Record<string, { type: "string" | "boolean"; default?: string | boolean }>;
    allowPositionals?: boolean;
  }): { values: Record<string, string | boolean | undefined>; positionals: string[] };
}

declare const process: {
  argv: string[];
  exitCode: number | undefined;
  stdin: { fd: number };
};

declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};
