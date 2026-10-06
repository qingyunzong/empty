// Minimal ambient Node.js declarations for offline compilation (no @types/node available).
// Covers only the APIs used by this project.

declare class Buffer extends Uint8Array {
  static from(data: string, encoding?: string): Buffer;
  static concat(list: readonly Buffer[]): Buffer;
  toString(encoding?: string): string;
}

declare var __dirname: string;

declare var process: {
  argv: string[];
  execPath: string;
  cwd(): string;
  exitCode: number | undefined;
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
};

declare module "node:fs" {
  export interface Stats {
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
    size: number;
    ino: number;
    atimeMs: number;
    mtimeMs: number;
    ctimeMs: number;
    atime: Date;
    mtime: Date;
    ctime: Date;
  }
  export function existsSync(path: string): boolean;
  export function writeSync(fd: number, data: string): number;
}

declare module "node:fs/promises" {
  import { Stats } from "node:fs";
  export { Stats };
  export function lstat(path: string): Promise<Stats>;
  export function stat(path: string): Promise<Stats>;
  export function readdir(path: string): Promise<string[]>;
  export function readlink(path: string): Promise<string>;
  export function readFile(path: string): Promise<Buffer>;
  export function readFile(path: string, encoding: "utf8"): Promise<string>;
  export function writeFile(path: string, data: string | Buffer): Promise<void>;
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  export function mkdtemp(prefix: string): Promise<string>;
  export function rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  export function symlink(target: string, path: string): Promise<void>;
  export function utimes(path: string, atime: Date | number, mtime: Date | number): Promise<void>;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
  export function isAbsolute(path: string): boolean;
  export function relative(from: string, to: string): string;
  export function dirname(path: string): string;
  export function basename(path: string): string;
  export const sep: string;
}

declare module "node:crypto" {
  export interface Hash {
    update(data: string | Buffer): Hash;
    digest(encoding: "hex"): string;
  }
  export function createHash(algorithm: string): Hash;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function match(value: string, regExp: RegExp, message?: string): void;
}

declare module "node:child_process" {
  export function execFile(
    file: string,
    args: readonly string[],
    callback: (error: (Error & { code?: number }) | null, stdout: string, stderr: string) => void
  ): void;
}
