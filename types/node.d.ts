// Minimal ambient declarations for the Node.js built-in modules used by this
// project. The environment has no network access to fetch @types/node, and the
// project deliberately depends on Node.js built-ins only.
declare module "node:fs" {
  export function writeFileSync(path: string, data: string): void;
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function renameSync(oldPath: string, newPath: string): void;
  export function openSync(path: string, flags: string): number;
  export function fsyncSync(fd: number): void;
  export function closeSync(fd: number): void;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
}
declare module "node:path" {
  export function join(...parts: string[]): string;
}
declare module "node:test" {
  export function test(name: string, fn: () => void): void;
}
declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function throws(fn: () => void, message?: string): void;
}
