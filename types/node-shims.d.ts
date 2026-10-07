declare module "node:test" {
  type TestFn = () => void | Promise<void>;
  interface Test {
    (name: string, fn: TestFn): void;
    (fn: TestFn): void;
  }
  const test: Test;
  export default test;
}
  declare module "node:assert" {
  interface Assert {
    (value: unknown, message?: string): asserts value;
    equal(a: unknown, b: unknown, message?: string): void;
    deepEqual(a: unknown, b: unknown, message?: string): void;
    strictEqual(a: unknown, b: unknown, message?: string): void;
    deepStrictEqual(a: unknown, b: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    match(value: string, pattern: RegExp, message?: string): void;
    doesNotMatch(value: string, pattern: RegExp, message?: string): void;
    throws(
      fn: () => unknown,
      matcher?: RegExp | (new (...args: never[]) => unknown) | ((e: unknown) => boolean),
      message?: string
    ): void;
    fail(message?: string): never;
  }
  const assert: Assert;
  export default assert;
}
declare module "node:fs" {
  export function readFileSync(path: string, encoding: string): string;
  export function writeFileSync(path: string, data: string): void;
  export function mkdtempSync(prefix: string): string;
}
declare module "node:path" {
  export function join(...parts: string[]): string;
}
declare module "node:os" {
  export function tmpdir(): string;
}
declare module "node:child_process" {
  export interface SpawnResult {
    status: number | null;
    stdout: string;
    stderr: string;
  }
  export function spawnSync(
    cmd: string,
    args: string[],
    opts: { input?: string; encoding?: string }
  ): SpawnResult;
}
declare const process: {
  argv: string[];
  exitCode: number | undefined;
  stdin: { on(event: string, cb: (chunk?: unknown) => void): void; setEncoding(enc: string): void };
  stdout: { write(s: string): void };
  stderr: { write(s: string): void };
  env: Record<string, string | undefined>;
};
declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};
