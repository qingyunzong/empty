// Minimal ambient declarations for the Node.js built-ins used by this
// project. They exist so `tsc` type-checks fully offline (no @types/node).
declare module "node:fs" {
  export function readFileSync(path: string | number, encoding: string): string;
  export function writeFileSync(path: string, data: string): void;
  export function rmSync(path: string, options?: { force?: boolean }): void;
}
declare module "node:os" {
  export function tmpdir(): string;
}
declare module "node:path" {
  export function join(...parts: string[]): string;
  export function dirname(p: string): string;
}
declare module "node:url" {
  export function fileURLToPath(url: string): string;
}
declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
}
declare module "node:assert/strict" {
  interface Assert {
    (value: unknown, message?: string): asserts value;
    ok(value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    strictEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    deepStrictEqual(actual: unknown, expected: unknown, message?: string): void;
    notStrictEqual(actual: unknown, expected: unknown, message?: string): void;
    match(actual: string, regexp: RegExp, message?: string): void;
    throws(fn: () => void, expected?: RegExp | ((error: Error) => boolean), message?: string): void;
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
  export function spawnSync(
    command: string,
    args: string[],
    options?: { encoding?: string; cwd?: string; input?: string }
  ): SpawnResult;
}
declare const process: {
  argv: string[];
  cwd(): string;
  exitCode: number;
  exit(code?: number): never;
};
declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};
interface ImportMeta {
  url: string;
}
