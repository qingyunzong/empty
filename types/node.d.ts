// Minimal type declarations for the Node.js built-in modules used by this
// project. The runtime depends on Node built-ins only; these declarations
// exist because the offline environment cannot fetch @types/node.

declare var console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

declare var process: {
  argv: string[];
  exitCode: number;
  cwd(): string;
};

declare module "node:fs" {
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function writeFileSync(path: string, data: string): void;
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function readdirSync(path: string): string[];
  export function renameSync(oldPath: string, newPath: string): void;
  export function linkSync(existingPath: string, newPath: string): void;
  export function unlinkSync(path: string): void;
  export function openSync(path: string, flags: string): number;
  export function writeSync(fd: number, data: string): number;
  export function fsyncSync(fd: number): void;
  export function closeSync(fd: number): void;
  export function mkdtempSync(prefix: string): string;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  export function statSync(path: string): { isFile(): boolean; isDirectory(): boolean };
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
  export function basename(path: string): string;
  export function isAbsolute(path: string): boolean;
  export const sep: string;
}

declare module "node:crypto" {
  export function randomUUID(): string;
}

declare module "node:child_process" {
  export function execFileSync(
    file: string,
    args: string[],
    options?: { encoding?: "utf8"; cwd?: string }
  ): string;
}

declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown): void;
  export function notEqual(actual: unknown, expected: unknown): void;
  export function deepEqual(actual: unknown, expected: unknown): void;
  export function ok(value: unknown): void;
  export function throws(
    fn: () => void,
    matcher?: RegExp | (new (...args: never[]) => Error) | ((error: unknown) => boolean)
  ): void;
}
