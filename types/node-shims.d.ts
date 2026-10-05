// Minimal ambient declarations for the Node.js built-ins used by this
// project. The runtime depends on Node built-ins only; these declarations
// exist because @types/node is not installable in this environment.

interface ImportMeta {
  url: string;
}

declare var console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

declare var process: {
  argv: string[];
  exitCode?: number;
  cwd(): string;
  exit(code?: number): never;
  stdout: { write(s: string): void };
  stderr: { write(s: string): void };
};

declare module "node:process" {
  export = process;
}

declare module "node:assert/strict" {
  export function equal(a: unknown, b: unknown, msg?: string): void;
  export function deepEqual(a: unknown, b: unknown, msg?: string): void;
  export function notEqual(a: unknown, b: unknown, msg?: string): void;
  export function ok(v: unknown, msg?: string): asserts v;
  export function throws(fn: () => unknown, match?: RegExp | (new (...a: never[]) => Error) | ((e: unknown) => boolean), msg?: string): void;
  export function fail(msg?: string): never;
  export function match(s: string, re: RegExp, msg?: string): void;
  const assert: {
    (v: unknown, msg?: string): asserts v;
    equal: typeof equal;
    deepEqual: typeof deepEqual;
    notEqual: typeof notEqual;
    ok: typeof ok;
    throws: typeof throws;
    fail: typeof fail;
    match: typeof match;
  };
  export default assert;
}

declare module "node:test" {
  type TestFn = () => void | Promise<void>;
  export function test(name: string, fn: TestFn): void;
  export function describe(name: string, fn: () => void): void;
  export default test;
}

declare module "node:fs" {
  export function readFileSync(path: string, enc: "utf8"): string;
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

declare module "node:util" {
  export interface ParseArgsConfig {
    args?: string[];
    allowPositionals?: boolean;
    strict?: boolean;
    options?: Record<string, { type: "string" | "boolean"; default?: string | boolean }>;
  }
  export function parseArgs(config: ParseArgsConfig): {
    values: Record<string, string | boolean | undefined>;
    positionals: string[];
  };
}

declare module "node:child_process" {
  export function execFileSync(
    file: string,
    args: string[],
    opts?: { encoding?: "utf8"; cwd?: string }
  ): string;
}

declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
}
