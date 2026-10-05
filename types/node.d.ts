// Minimal offline type shims for the Node.js built-in modules used by this
// project. The environment has no @types/node and no network access, so only
// the exact APIs we rely on are declared here.

declare module "node:fs" {
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function existsSync(path: string): boolean;
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function writeFileSync(path: string, data: string): void;
  export function appendFileSync(path: string, data: string): void;
  export function renameSync(from: string, to: string): void;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  export function mkdtempSync(prefix: string): string;
  export function openSync(path: string, flags: string): number;
  export function fsyncSync(fd: number): void;
  export function closeSync(fd: number): void;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module "node:assert" {
  export function strictEqual(actual: unknown, expected: unknown, message?: string): void;
  export function notStrictEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepStrictEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function throws(fn: () => unknown, expected?: unknown, message?: string): void;
}

declare function structuredClone<T>(value: T): T;

declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};
