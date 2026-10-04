// Minimal ambient declarations for the Node.js built-in modules used by this
// project. The offline environment has no @types/node, so we declare only the
// surface we actually consume. Everything here maps to Node.js built-ins.
declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function writeFileSync(path: string, data: string): void;
  export function mkdirSync(path: string, opts?: { recursive?: boolean }): void;
  export function existsSync(path: string): boolean;
  export function mkdtempSync(prefix: string): string;
  export function rmSync(path: string, opts?: { recursive?: boolean; force?: boolean }): void;
  export function openSync(path: string, flags: string): number;
  export function closeSync(fd: number): void;
}
declare module "node:path" {
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
  export function basename(p: string): string;
}
declare module "node:os" {
  export function tmpdir(): string;
}
declare module "node:process" {
  interface Process {
    argv: string[];
    execPath: string;
    exitCode: number | undefined;
    stdout: { write(s: string): void };
    stderr: { write(s: string): void };
  }
  const process: Process;
  export = process;
}
declare module "node:assert/strict" {
  interface Assert {
    (value: unknown, message?: string): asserts value;
    equal(a: unknown, b: unknown, message?: string): void;
    deepEqual(a: unknown, b: unknown, message?: string): void;
    notEqual(a: unknown, b: unknown, message?: string): void;
    ok(value: unknown, message?: string): asserts value;
    match(s: string, re: RegExp, message?: string): void;
    throws(fn: () => void, message?: string): void;
  }
  const assert: Assert;
  export = assert;
}
declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
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
    opts?: { encoding?: "utf8"; cwd?: string; stdio?: unknown[] }
  ): SpawnResult;
}
declare module "node:url" {
  export function fileURLToPath(url: string): string;
}
interface ImportMeta {
  url: string;
}
// Global `process` (Node.js built-in global).
declare const process: {
  argv: string[];
  execPath: string;
  exitCode: number | undefined;
  stdout: { write(s: string): void };
  stderr: { write(s: string): void };
};
