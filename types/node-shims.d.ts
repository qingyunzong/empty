// Minimal ambient declarations for the Node.js APIs used by this project.
// The environment has no @types/node available offline, so we declare only
// the exact surface we rely on.

declare class Buffer extends Uint8Array {}

declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
};

declare const process: {
  argv: string[];
  execPath: string;
  exitCode: number | undefined;
  cwd(): string;
  env: Record<string, string | undefined>;
  stdout: { write(data: string): boolean };
  stderr: { write(data: string): boolean };
};

declare function setTimeout(callback: () => void, ms?: number): unknown;
declare function setInterval(callback: () => void, ms?: number): unknown;
declare function clearInterval(handle: unknown): void;

interface ImportMeta {
  url: string;
}

declare module 'node:url' {
  export function fileURLToPath(url: string): string;
}

declare module 'node:fs' {
  export class Stats {
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
    size: number;
    mtimeMs: number;
    ctimeMs: number;
    ino: number;
  }
}

declare module 'node:fs/promises' {
  import { Stats } from 'node:fs';
  export function lstat(path: string): Promise<Stats>;
  export function stat(path: string): Promise<Stats>;
  export function readdir(path: string): Promise<string[]>;
  export function readlink(path: string): Promise<string>;
  export function readFile(path: string): Promise<Buffer>;
  export function readFile(path: string, encoding: 'utf8'): Promise<string>;
  export function writeFile(path: string, data: string | Uint8Array, encoding?: 'utf8'): Promise<void>;
  export function appendFile(path: string, data: string): Promise<void>;
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  export function rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  export function mkdtemp(prefix: string): Promise<string>;
  export function utimes(path: string, atime: number | Date, mtime: number | Date): Promise<void>;
  export function chmod(path: string, mode: number): Promise<void>;
  export function symlink(target: string, path: string): Promise<void>;
  export function rename(oldPath: string, newPath: string): Promise<void>;
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
  export function relative(from: string, to: string): string;
  export function dirname(path: string): string;
  export function basename(path: string): string;
  export const sep: string;
}

declare module 'node:crypto' {
  export interface Hash {
    update(data: string | Uint8Array): Hash;
    digest(encoding: 'hex'): string;
  }
  export function createHash(algorithm: string): Hash;
}

declare module 'node:os' {
  export function tmpdir(): string;
}

declare module 'node:test' {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module 'node:assert/strict' {
  export function ok(value: unknown, message?: string): asserts value;
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function match(actual: string, regexp: RegExp, message?: string): void;
}

declare module 'node:child_process' {
  export function execFileSync(
    file: string,
    args?: string[],
    options?: { encoding?: 'utf8'; cwd?: string }
  ): string;
}
