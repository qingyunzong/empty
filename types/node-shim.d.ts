// Minimal ambient declarations for the Node APIs used by this project.
// (@types/node is not installable in this offline environment.)
declare module "node:test" {
  export interface TestContext {
    name: string;
  }
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): asserts value;
  export function throws(fn: () => unknown, matcher?: unknown, message?: string): void;
  export function match(value: string, pattern: RegExp, message?: string): void;
  export function fail(message?: string): never;
}

declare module "node:fs" {
  export function mkdirSync(path: string, opts?: { recursive?: boolean }): void;
  export function writeFileSync(path: string, data: string): void;
  export function readFileSync(path: string, encoding: string): string;
  export function existsSync(path: string): boolean;
  export function mkdtempSync(prefix: string): string;
  export function readdirSync(path: string): string[];
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
}

declare const process: { cwd(): string };
