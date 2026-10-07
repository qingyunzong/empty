// Minimal ambient declarations for the Node APIs used by this project.
// (The sandbox has no network access to install @types/node.)

declare module "node:crypto" {
  export interface Hash {
    update(data: string, encoding?: string): Hash;
    digest(encoding: string): string;
  }
  export function createHash(algorithm: string): Hash;
}

declare module "node:fs" {
  export interface Stats {
    isDirectory(): boolean;
    isFile(): boolean;
  }
  export function readdirSync(path: string): string[];
  export function readFileSync(path: string, encoding: string): string;
  export function statSync(path: string): Stats;
  export function writeFileSync(path: string, data: string): void;
  export function mkdtempSync(prefix: string): string;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  export function unlinkSync(path: string): void;
}

declare module "node:path" {
  export const sep: string;
  export function join(...parts: string[]): string;
  export function relative(from: string, to: string): string;
  export function dirname(path: string): string;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:child_process" {
  export interface SpawnSyncResult {
    status: number | null;
    error?: Error;
  }
  export function spawnSync(
    command: string,
    options?: { cwd?: string; shell?: boolean; stdio?: string },
  ): SpawnSyncResult;
}

declare module "node:test" {
  export interface TestContext {
    skip(message?: string): void;
  }
  export function test(name: string, fn: (t: TestContext) => void | Promise<void>): void;
}

declare module "node:assert/strict" {
  interface Assert {
    (value: unknown, message?: string): asserts value;
    ok(value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    throws(fn: () => void, pattern?: RegExp, message?: string): void;
    match(value: string, pattern: RegExp, message?: string): void;
  }
  const assert: Assert;
  export default assert;
}
