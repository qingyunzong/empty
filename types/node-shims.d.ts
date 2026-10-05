// Minimal Node.js ambient declarations (no @types/node in this offline env).
declare var console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};
declare var process: {
  argv: string[];
  exitCode: number;
  env: { [key: string]: string | undefined };
};
declare var require: { main: unknown };
declare var module: unknown;

declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function writeFileSync(path: string, data: string): void;
}
declare module "node:test" {
  function test(name: string, fn: () => void | Promise<void>): void;
  export = test;
}
declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function throws(fn: () => unknown, message?: string): void;
}
declare module "node:child_process" {
  export function execFileSync(
    file: string,
    args: string[],
    options: { encoding: "utf8" }
  ): string;
}
