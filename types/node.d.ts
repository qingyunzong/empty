// Minimal ambient declarations for the Node.js built-in modules used here.
// The project intentionally has zero npm dependencies (network-independent),
// so these stand in for @types/node and cover only the APIs we call.

declare module "node:fs" {
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, opts?: { recursive?: boolean }): void;
  export function readFileSync(path: string): Uint8Array;
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function writeFileSync(path: string | number, data: string | Uint8Array): void;
  export function renameSync(from: string, to: string): void;
  export function unlinkSync(path: string): void;
  export function rmSync(path: string, opts?: { recursive?: boolean; force?: boolean }): void;
  export function readdirSync(path: string): string[];
  export function mkdtempSync(prefix: string): string;
  export function statSync(path: string): { isFile(): boolean; isDirectory(): boolean; mtimeMs: number };
  export function openSync(path: string, flags: string): number;
  export function fsyncSync(fd: number): void;
  export function closeSync(fd: number): void;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
  export function dirname(path: string): string;
  export function basename(path: string): string;
  export const sep: string;
}

declare module "node:crypto" {
  export interface Hash {
    update(data: string | Uint8Array): Hash;
    digest(encoding: "hex"): string;
  }
  export function createHash(algorithm: string): Hash;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
}

declare module "node:assert/strict" {
  export function ok(value: unknown, message?: string): asserts value;
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function match(actual: string, regexp: RegExp, message?: string): void;
  export function throws(fn: () => unknown, expected?: RegExp | ((err: unknown) => boolean) | (new (message: string) => Error), message?: string): void;
  export function rejects(fn: () => Promise<unknown>, expected?: RegExp | ((err: unknown) => boolean), message?: string): Promise<void>;
}

declare const process: {
  pid: number;
  cwd(): string;
};
