declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

declare const URL: new (url: string) => { href: string };

declare module "node:fs" {
  export function readFileSync(path: string, encoding: string): string;
  export function writeFileSync(path: string, data: string): void;
  export function writeSync(fd: number, data: string): number;
  export function appendFileSync(path: string, data: string): void;
  export function mkdirSync(path: string, opts?: { recursive?: boolean }): void;
  export function mkdtempSync(prefix: string): string;
}

declare module "node:path" {
  export function dirname(p: string): string;
  export function resolve(...parts: string[]): string;
  export function join(...parts: string[]): string;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:crypto" {
  export interface Hash {
    update(data: string): Hash;
    digest(encoding: string): string;
  }
  export function createHash(algorithm: string): Hash;
}

declare module "node:process" {
  const process: {
    argv: string[];
    exitCode: number;
    cwd(): string;
    exit(code?: number): never;
    stdout: { write(s: string): void };
    stderr: { write(s: string): void };
  };
  export default process;
}

declare module "node:child_process" {
  export interface SpawnResult {
    status: number | null;
    stdout: string;
    stderr: string;
  }
  export function spawnSync(
    cmd: string,
    args: string[],
    opts?: { encoding?: string; cwd?: string }
  ): SpawnResult;
}

declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  const assert: {
    equal: typeof equal;
    deepEqual: typeof deepEqual;
    ok: typeof ok;
  };
  export default assert;
}
