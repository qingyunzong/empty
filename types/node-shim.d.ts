// Minimal ambient declarations for the Node.js APIs used by this project.
// The environment has no network access, so @types/node cannot be installed;
// these shims cover exactly the surface the code relies on.

declare module 'node:fs' {
  export interface Stats {
    dev: number;
    ino: number;
    mode: number;
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
  }
  export function lstatSync(path: string): Stats;
  export function renameSync(oldPath: string, newPath: string): void;
  export function openSync(path: string, flags: string): number;
  export function closeSync(fd: number): void;
  export function fsyncSync(fd: number): void;
  export function writeFileSync(path: string | number, data: string): void;
  export function writeSync(fd: number, data: string): void;
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function readdirSync(path: string): string[];
  export function unlinkSync(path: string): void;
  export function mkdirSync(path: string, opts?: { recursive?: boolean }): void;
  export function mkdtempSync(prefix: string): string;
  export function rmSync(path: string, opts?: { recursive?: boolean; force?: boolean }): void;
  export function symlinkSync(target: string, path: string): void;
  export function readlinkSync(path: string): string;
  export function existsSync(path: string): boolean;
}

declare module 'node:path' {
  export function resolve(...parts: string[]): string;
  export function join(...parts: string[]): string;
  export function dirname(p: string): string;
  export function basename(p: string): string;
}

declare module 'node:crypto' {
  export function randomBytes(size: number): { toString(encoding: string): string };
}

declare module 'node:os' {
  export function tmpdir(): string;
}

declare module 'node:child_process' {
  export interface SpawnSyncResult {
    status: number | null;
    stdout: string;
    stderr: string;
  }
  export function spawnSync(
    command: string,
    args: string[],
    options: { cwd?: string; env?: Record<string, string | undefined>; encoding: 'utf8' },
  ): SpawnSyncResult;
}

declare module 'node:test' {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module 'node:assert/strict' {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function match(value: string, regExp: RegExp, message?: string): void;
  const assert: {
    equal: typeof equal;
    deepEqual: typeof deepEqual;
    ok: typeof ok;
    match: typeof match;
  };
  export default assert;
}

declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  pid: number;
  execPath: string;
  cwd(): string;
  exit(code?: number): never;
};

declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

interface ImportMeta {
  dirname: string;
}
