// 最小 Node.js 内置库类型声明（环境无 @types/node，仅声明用到的 API）

declare var console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

declare var process: {
  argv: string[];
  exitCode: number | undefined;
  env: Record<string, string | undefined>;
  cwd(): string;
};

declare module "node:fs" {
  export function readFileSync(path: string | number, encoding: string): string;
  export function existsSync(path: string): boolean;
}

declare module "node:test" {
  export interface TestContext {
    skip(message?: string): void;
  }
  type TestFn = (t?: TestContext) => void | Promise<void>;
  interface Test {
    (name: string, fn: TestFn): void;
    skip(name: string, fn: TestFn): void;
  }
  const test: Test;
  export default test;
}

declare module "node:assert/strict" {
  interface Assert {
    (value: unknown, message?: string): void;
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): asserts value;
    doesNotThrow(fn: () => void, message?: string): void;
    throws(fn: () => void, expected?: RegExp | ((err: unknown) => boolean), message?: string): void;
    match(actual: string, expected: RegExp, message?: string): void;
    doesNotMatch(actual: string, expected: RegExp, message?: string): void;
    fail(message?: string): never;
  }
  const assert: Assert;
  export default assert;
}

declare module "node:child_process" {
  export interface SpawnResult {
    status: number | null;
    stdout: string;
    stderr: string;
  }
  export function execFileSync(
    file: string,
    args: string[],
    options: { encoding: string; input?: string; cwd?: string }
  ): string;
  export function spawnSync(
    file: string,
    args: string[],
    options: { encoding: string; input?: string; cwd?: string }
  ): SpawnResult;
}

declare var module: { id: string };

declare var require:
  | { (id: string): unknown; main: { id: string } | undefined }
  | undefined;
