declare module "node:fs" {
  export function readFileSync(path: number | string, encoding?: string): string;
}

declare module "node:test" {
  type TestFn = (t: unknown) => void | Promise<void>;
  export function test(name: string, fn: TestFn): void;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: TestFn): void;
}

declare module "node:assert/strict" {
  export function ok(value: unknown, message?: string): asserts value;
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function throws(fn: () => void, match?: RegExp | ((e: Error) => boolean)): void;
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
    options?: { cwd?: string; input?: string; encoding?: string },
  ): SpawnResult;
}

declare const process: {
  argv: string[];
  exit(code?: number): never;
  cwd(): string;
};

declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};
