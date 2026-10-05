// Minimal Node.js typings (offline environment, no @types/node).
declare const process: {
  argv: string[];
  exitCode: number | undefined;
  env: Record<string, string | undefined>;
};

declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

declare module "node:fs" {
  export function readFileSync(path: string | number, encoding: string): string;
}

declare module "node:test" {
  export default function test(name: string, fn: () => void): void;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function throws(fn: () => void, expected?: RegExp): void;
}
