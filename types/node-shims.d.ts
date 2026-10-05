declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
  export default test;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function match(value: unknown, pattern: RegExp, message?: string): void;
  export function throws(fn: () => void, matcher?: RegExp | ((err: unknown) => boolean), message?: string): void;
  const assert: {
    equal: typeof equal;
    notEqual: typeof notEqual;
    deepEqual: typeof deepEqual;
    ok: typeof ok;
    match: typeof match;
    throws: typeof throws;
  };
  export default assert;
}

declare module "node:fs" {
  export function readFileSync(path: string | number, encoding: "utf8"): string;
  export function existsSync(path: string): boolean;
}

declare module "node:path" {
  export function resolve(...parts: string[]): string;
  export function join(...parts: string[]): string;
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
    options: { cwd?: string; input?: string; encoding: "utf8" }
  ): SpawnResult;
}

declare const process: {
  argv: string[];
  cwd(): string;
  exitCode: number | undefined;
  stdin: { fd: number };
  stdout: { write(text: string): void };
  stderr: { write(text: string): void };
  hrtime: { bigint(): bigint };
};

declare const require: { main: unknown };
declare const module: unknown;
