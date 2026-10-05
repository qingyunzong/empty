// Minimal offline type declarations for the Node.js built-in modules used by
// this project. The environment has no network access, so @types/node cannot
// be installed; only the small surface we actually use is declared here.

declare module "node:fs" {
  export function mkdirSync(
    path: string,
    options?: { recursive?: boolean; mode?: number }
  ): void;
  export function writeFileSync(
    path: string,
    data: string,
    options?: { mode?: number; encoding?: string }
  ): void;
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function renameSync(oldPath: string, newPath: string): void;
  export function rmSync(
    path: string,
    options?: { recursive?: boolean; force?: boolean }
  ): void;
  export function rmdirSync(path: string): void;
  export function existsSync(path: string): boolean;
  export function statSync(path: string): {
    mode: number;
    isFile(): boolean;
    isDirectory(): boolean;
  };
  export function mkdtempSync(prefix: string): string;
  export function readdirSync(path: string): string[];
  export function chmodSync(path: string, mode: number): void;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
  export function dirname(p: string): string;
  export function basename(p: string): string;
}

declare module "node:crypto" {
  export function randomUUID(): string;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function match(actual: string, regexp: RegExp, message?: string): void;
  export function rejects(
    promise: Promise<unknown>,
    matcher?: ((err: unknown) => boolean) | RegExp | object,
    message?: string
  ): Promise<void>;
}
