// Minimal type declarations for the Node.js built-in modules used by this
// project. The environment has no network access to fetch @types/node, and
// the project deliberately depends on Node.js built-in libraries only.

declare var console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

declare module "node:process" {
  const process: {
    argv: string[];
    pid: number;
    exitCode: number | undefined;
    cwd(): string;
    stdout: { write(s: string): void };
    stderr: { write(s: string): void };
  };
  export default process;
}

declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function writeFileSync(path: string, data: string): void;
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, options: { recursive: boolean }): void;
  export function rmSync(path: string, options: { recursive: boolean; force: boolean }): void;
}

declare module "node:util" {
  export interface ParseArgsConfig {
    args?: string[];
    allowPositionals?: boolean;
    strict?: boolean;
    options?: Record<
      string,
      { type: "string" | "boolean"; short?: string; multiple?: boolean; default?: string | boolean }
    >;
  }
  export function parseArgs(config: ParseArgsConfig): {
    values: Record<string, string | boolean | (string | boolean)[] | undefined>;
    positionals: string[];
  };
}

declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function throws(fn: () => void, matcher?: RegExp | ((err: unknown) => boolean)): void;
  export function match(actual: string, regexp: RegExp): void;
}

declare module "node:child_process" {
  export function execFileSync(
    file: string,
    args: string[],
    options: { encoding: "utf8"; cwd?: string }
  ): string;
}
