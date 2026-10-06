// Minimal ambient declarations for the Node.js APIs used by this project.
// (@types/node cannot be installed in this offline environment.)
declare module "node:fs" {
  export interface Stats {
    dev: number;
    ino: number;
    mode: number;
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
  }
  export function lstatSync(p: string): Stats;
  export function statSync(p: string): Stats;
  export function renameSync(oldPath: string, newPath: string): void;
  export function readFileSync(p: string, encoding: string): string;
  export function writeFileSync(p: string, data: string): void;
  export function unlinkSync(p: string): void;
  export function mkdirSync(p: string, opts?: { recursive?: boolean }): void;
  export function mkdtempSync(prefix: string): string;
  export function readdirSync(p: string): string[];
  export function symlinkSync(target: string, p: string): void;
  export function readlinkSync(p: string): string;
  export function existsSync(p: string): boolean;
  export function openSync(p: string, flags: string): number;
  export function writeSync(fd: number, data: string): number;
  export function fsyncSync(fd: number): void;
  export function closeSync(fd: number): void;
  export function rmSync(p: string, opts?: { recursive?: boolean; force?: boolean }): void;
}
declare module "node:path" {
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
  export function dirname(p: string): string;
  export function basename(p: string): string;
  export function isAbsolute(p: string): boolean;
  export function relative(from: string, to: string): string;
}
declare module "node:os" {
  export function tmpdir(): string;
}
declare module "node:crypto" {
  export function randomBytes(size: number): { toString(encoding: string): string };
}
declare module "node:test" {
  export function test(name: string, fn: () => void): void;
}
declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function match(actual: string, regexp: RegExp): void;
}
declare module "node:child_process" {
  export interface SpawnSyncResult {
    status: number | null;
    stdout: string;
    stderr: string;
  }
  export function spawnSync(
    command: string,
    args: string[],
    options?: { env?: Record<string, string | undefined>; cwd?: string; encoding?: string }
  ): SpawnSyncResult;
}
declare var process: {
  argv: string[];
  env: Record<string, string | undefined>;
  exit(code?: number): never;
  cwd(): string;
  pid: number;
  execPath: string;
  stdout: { write(s: string): void };
  stderr: { write(s: string): void };
};
declare var __dirname: string;
