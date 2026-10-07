// Minimal ambient declarations for the Node.js built-in modules used by this
// project. The environment has no registry access, so @types/node cannot be
// installed; only the small surface we actually use is declared here.

declare module "node:assert" {
  export function deepStrictEqual(actual: unknown, expected: unknown, message?: string): void;
  export function strictEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function fail(message?: string): never;
  export function throws(fn: () => void, error?: unknown, message?: string): void;
  const assert: {
    deepStrictEqual: typeof deepStrictEqual;
    strictEqual: typeof strictEqual;
    ok: typeof ok;
    fail: typeof fail;
    throws: typeof throws;
  };
  export default assert;
}

declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => void | Promise<void>): void;
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
    options: { cwd?: string; encoding: "utf8" }
  ): SpawnResult;
}

declare module "node:path" {
  export function resolve(...parts: string[]): string;
  export function join(...parts: string[]): string;
}

declare module "node:process" {
  const process: {
    argv: string[];
    execPath: string;
    cwd(): string;
    exitCode?: number;
  };
  export default process;
}

declare const __dirname: string;

declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

declare const require: { main?: unknown };
declare const module: { id: string };
