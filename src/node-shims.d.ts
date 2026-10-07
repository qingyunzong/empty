// 本工程零外部依赖，未安装 @types/node；以下为用到的 Node 内置 API 的最小声明。
declare module "node:assert" {
  interface AssertFn {
    (value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    strictEqual(actual: unknown, expected: unknown, message?: string): void;
    deepStrictEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    match(actual: string, regexp: RegExp, message?: string): void;
    doesNotMatch(actual: string, regexp: RegExp, message?: string): void;
    ok(value: unknown, message?: string): asserts value;
    fail(message?: string): never;
  }
  const assert: AssertFn;
  export default assert;
}

declare module "node:assert/strict" {
  import assert from "node:assert";
  export default assert;
}

declare module "node:test" {
  export function test(name: string, fn: () => unknown): unknown;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => unknown): unknown;
}

declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function existsSync(path: string): boolean;
}

declare module "node:child_process" {
  export function execFileSync(
    file: string,
    args: string[],
    options: { encoding: "utf8" },
  ): string;
}

declare const process: {
  argv: string[];
  exit(code?: number): never;
  cwd(): string;
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
};

declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};
