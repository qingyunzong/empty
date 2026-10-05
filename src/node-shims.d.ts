// Minimal ambient declarations for the Node.js built-in modules and globals
// used by this project. The runtime relies on Node.js built-ins only; these
// declarations exist so `tsc` can type-check without `@types/node`.

declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

declare const process: {
  argv: string[];
  execPath: string;
  exitCode: number;
  cwd(): string;
  env: Record<string, string | undefined>;
};

declare const __dirname: string;

declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module "node:assert" {
  export function ok(value: unknown, message?: string): asserts value;
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function strictEqual(actual: unknown, expected: unknown, message?: string): void;
  export function notStrictEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepStrictEqual(actual: unknown, expected: unknown, message?: string): void;
  export function throws(fn: () => void, error?: RegExp | (() => boolean), message?: string): void;
  export function match(value: string, regExp: RegExp, message?: string): void;
}

declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function writeFileSync(path: string, data: string): void;
  export function existsSync(path: string): boolean;
  export function mkdtempSync(prefix: string): string;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
}

declare module "node:child_process" {
  export interface SpawnSyncResult {
    status: number | null;
    stdout: string;
    stderr: string;
  }
  export function spawnSync(
    file: string,
    args: string[],
    options: { encoding: "utf8" }
  ): SpawnSyncResult;
}
