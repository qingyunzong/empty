// Minimal Node.js type declarations (offline environment, no @types/node).
declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): unknown;
  export default test;
}
declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function throws(fn: () => unknown, message?: string): void;
}
declare module "node:fs" {
  export function readFileSync(path: string | number, encoding: string): string;
  export function writeFileSync(path: string, data: string): void;
}
declare module "node:os" {
  export function tmpdir(): string;
}
declare module "node:path" {
  export function join(...parts: string[]): string;
}
declare module "node:child_process" {
  export function execFileSync(
    cmd: string,
    args: string[],
    options?: { input?: string; encoding?: string }
  ): string;
}
declare var process: {
  argv: string[];
  env: Record<string, string | undefined>;
  exitCode: number | undefined;
};
declare var __dirname: string;
declare var module: { id: string };
declare var require: { main: unknown };
