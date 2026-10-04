declare function structuredClone<T>(value: T): T;

declare var process: {
  argv: string[];
  exitCode: number;
  cwd(): string;
};

declare var console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

declare var module: { id: string; filename: string };

declare var require: { main: unknown };

declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function writeFileSync(path: string, data: string): void;
}

declare module "node:util" {
  export function parseArgs(config: {
    args?: string[];
    options?: Record<string, { type: "string" | "boolean"; default?: string | boolean }>;
    allowPositionals?: boolean;
  }): { values: Record<string, string | boolean | undefined>; positionals: string[] };
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function notDeepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): asserts value;
  export function throws(
    fn: () => unknown,
    expected?: RegExp | ((err: unknown) => boolean) | (new (message?: string) => Error),
    message?: string
  ): void;
}

declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
}

declare module "node:child_process" {
  export function execFileSync(
    file: string,
    args?: string[],
    options?: { cwd?: string; encoding?: "utf8" }
  ): string;
}
