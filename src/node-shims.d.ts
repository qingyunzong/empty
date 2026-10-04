// 最小化的 Node.js 内置模块类型声明（环境离线，无法安装 @types/node）。
declare const process: {
  argv: string[];
  exitCode?: number;
  cwd(): string;
  stdout: { write(s: string): void };
  stderr: { write(s: string): void };
};

declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function writeFileSync(path: string, data: string): void;
}

declare module "node:util" {
  interface ParseArgsConfig {
    args?: string[];
    allowPositionals?: boolean;
    strict?: boolean;
    options?: Record<string, { type: "string" | "boolean"; short?: string; default?: string | boolean }>;
  }
  export function parseArgs(config: ParseArgsConfig): {
    values: Record<string, string | boolean | undefined>;
    positionals: string[];
  };
}

declare module "node:test" {
  type TestFn = () => void | Promise<void>;
  interface TestContext {
    name: string;
  }
  export function test(name: string, fn: TestFn): void;
  export function describe(name: string, fn: () => void): void;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): asserts value;
  export function fail(message?: string): never;
}

declare function structuredClone<T>(value: T): T;

declare module "node:assert/strict" {
  export function throws(fn: () => unknown, pattern?: RegExp, message?: string): void;
}
