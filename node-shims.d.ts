// Minimal Node.js type declarations for the built-in modules used here.
// The environment has no @types/node; runtime is Node 22 built-ins only.

declare var console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

declare var process: {
  exit(code?: number): never;
};

declare module "node:fs" {
  export function readFileSync(path: string | number, encoding: "utf8"): string;
  export function writeFileSync(path: string, data: string): void;
  export function writeSync(fd: number, data: string): number;
}

declare module "node:util" {
  export interface ParseArgsOptionConfig {
    type: "string" | "boolean";
    default?: string | boolean;
  }
  export interface ParseArgsConfig {
    options?: Record<string, ParseArgsOptionConfig>;
    allowPositionals?: boolean;
  }
  export function parseArgs(config: ParseArgsConfig): {
    values: Record<string, string | boolean | undefined>;
    positionals: string[];
  };
}

declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): asserts value;
  export function match(value: string, regExp: RegExp, message?: string): void;
  export function throws(fn: () => unknown, error?: RegExp, message?: string): void;
}

declare module "node:child_process" {
  export interface SpawnSyncResult {
    status: number | null;
    stdout: string;
    stderr: string;
  }
  export function spawnSync(
    command: string,
    args: string[],
    options?: { encoding?: string; input?: string },
  ): SpawnSyncResult;
}
