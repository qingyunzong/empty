declare module "node:fs" {
  export interface Stats {
    dev: number;
    ino: number;
    isDirectory(): boolean;
    isFile(): boolean;
  }
  export function existsSync(path: string): boolean;
  export function renameSync(oldPath: string, newPath: string): void;
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function writeFileSync(path: string, data: string): void;
  export function readdirSync(path: string): string[];
  export function statSync(path: string): Stats;
  export function mkdirSync(path: string, opts?: { recursive?: boolean }): void;
  export function mkdtempSync(prefix: string): string;
  export function rmSync(path: string, opts?: { recursive?: boolean; force?: boolean }): void;
  export function unlinkSync(path: string): void;
  export function copyFileSync(src: string, dest: string): void;
}

declare module "node:path" {
  export const sep: string;
  export function resolve(...parts: string[]): string;
  export function join(...parts: string[]): string;
  export function dirname(p: string): string;
  export function basename(p: string, ext?: string): string;
  export function extname(p: string): string;
  export function normalize(p: string): string;
  export function isAbsolute(p: string): boolean;
  export function relative(from: string, to: string): string;
}

declare module "node:crypto" {
  export function randomUUID(): string;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:child_process" {
  export function execFileSync(
    file: string,
    args: string[],
    opts?: { cwd?: string; encoding?: "utf8"; stdio?: string },
  ): string;
}

declare module "node:process" {
  const process: {
    argv: string[];
    execPath: string;
    cwd(): string;
    exitCode: number | undefined;
    stdout: { write(s: string): boolean };
    stderr: { write(s: string): boolean };
  };
  export default process;
}

declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
}

declare module "node:assert/strict" {
  export function ok(value: unknown, message?: string): void;
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepStrictEqual(actual: unknown, expected: unknown, message?: string): void;
  export function throws(fn: () => void, matcher?: RegExp | ((err: Error) => boolean), message?: string): void;
  export function doesNotThrow(fn: () => void, message?: string): void;
  export function match(value: string, pattern: RegExp, message?: string): void;
  export function fail(message?: string): never;
}

declare module "node:url" {
  export function fileURLToPath(url: string): string;
  export function pathToFileURL(path: string): { href: string };
}

interface ImportMeta {
  url: string;
}
