// Minimal ambient declarations for the Node.js built-in modules used by this
// project. The environment has no @types/node and no network access, so only
// the APIs actually consumed are declared here.
declare module "node:fs" {
  export function mkdirSync(path: string, opts?: { recursive?: boolean }): void;
  export function existsSync(path: string): boolean;
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function writeFileSync(path: string, data: string): void;
  export function readdirSync(path: string): string[];
  export function mkdtempSync(prefix: string): string;
  export function rmSync(path: string, opts?: { recursive?: boolean; force?: boolean }): void;
  export function openSync(path: string, flags: string): number;
  export function writeSync(fd: number, data: string): number;
  export function fsyncSync(fd: number): void;
  export function closeSync(fd: number): void;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function throws(fn: () => void, match?: RegExp | ((err: unknown) => boolean) | (new (...args: never[]) => Error), message?: string): void;
  export function doesNotThrow(fn: () => void, message?: string): void;
}

declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
}
