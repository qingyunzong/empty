// Minimal ambient declarations for the Node.js APIs used by this project.
// (No network access to install @types/node.)

interface ImportMeta {
  url: string;
}

declare var process: {
  argv: string[];
  exitCode: number | undefined;
  stdout: { write(s: string): void };
  stderr: { write(s: string): void };
  exit(code?: number): never;
};

declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
}

declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): asserts value;
  export function match(actual: string, regexp: RegExp, message?: string): void;
  export function throws(fn: () => void, expected?: RegExp | ((err: unknown) => boolean) | (new (...args: never[]) => Error), message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
}

declare module "node:child_process" {
  export interface SpawnResult {
    status: number | null;
    stdout: string;
    stderr: string;
  }
  export function spawnSync(
    command: string,
    args: string[],
    options?: { encoding?: string; cwd?: string }
  ): SpawnResult;
}

declare module "node:path" {
  export function resolve(...parts: string[]): string;
  export function dirname(p: string): string;
}

declare module "node:url" {
  export function fileURLToPath(url: string): string;
}
