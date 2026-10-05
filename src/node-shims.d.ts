// Minimal Node.js typings (offline environment, no @types/node available).
declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};
declare const process: {
  argv: string[];
  exit(code?: number): never;
};
declare function require(id: string): unknown;
declare module "node:fs" {
  export function readFileSync(path: string, encoding: string): string;
  export function writeFileSync(path: string, data: string): void;
}
declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export default test;
}
declare module "node:assert" {
  export function equal(a: unknown, b: unknown, msg?: string): void;
  export function deepEqual(a: unknown, b: unknown, msg?: string): void;
  export function ok(v: unknown, msg?: string): void;
  export function throws(fn: () => void, re?: RegExp): void;
}
declare module "node:assert/strict" {
  export function equal(a: unknown, b: unknown, msg?: string): void;
  export function deepEqual(a: unknown, b: unknown, msg?: string): void;
  export function ok(v: unknown, msg?: string): void;
  export function throws(fn: () => void, re?: RegExp): void;
}
