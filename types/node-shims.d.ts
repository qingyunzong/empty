// Minimal ambient declarations for the Node.js built-in modules used by this
// project. The environment is offline, so @types/node cannot be installed;
// only the exact APIs we rely on are declared here.

declare module "node:fs" {
  export function readFileSync(path: string | number, encoding: "utf8"): string;
}

declare module "node:util" {
  export interface ParseArgsConfig {
    args?: string[];
    allowPositionals?: boolean;
    options?: Record<string, { type: "string" | "boolean"; default?: string | boolean }>;
  }
  export function parseArgs(config: ParseArgsConfig): {
    values: Record<string, string | boolean | undefined>;
    positionals: string[];
  };
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function throws(fn: () => unknown, match?: RegExp | ((err: unknown) => boolean), message?: string): void;
}

declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export default test;
}

declare const process: {
  argv: string[];
  exitCode: number | undefined;
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
};
