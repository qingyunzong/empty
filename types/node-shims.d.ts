// Minimal ambient declarations for the Node.js built-in modules used by this
// project. The environment has no registry access, so @types/node cannot be
// installed; only the small surface we actually use is declared here.

declare module "node:assert/strict" {
  export function ok(value: unknown, message?: string): asserts value;
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function throws(fn: () => unknown, expected?: RegExp | ((err: unknown) => boolean), message?: string): void;
  export function match(actual: string, expected: RegExp, message?: string): void;
}

declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
}

declare module "node:child_process" {
  export interface SpawnSyncResult {
    status: number | null;
    stdout: string;
    stderr: string;
  }
  export function spawnSync(
    command: string,
    args?: readonly string[],
    options?: { encoding?: "utf8"; input?: string; cwd?: string }
  ): SpawnSyncResult;
}

declare module "node:process" {
  const process: {
    argv: string[];
    execPath: string;
    exitCode: number | undefined;
    cwd(): string;
    stdin: {
      setEncoding(encoding: string): void;
      on(event: "data", listener: (chunk: unknown) => void): void;
      on(event: "end", listener: () => void): void;
      on(event: "error", listener: (err: unknown) => void): void;
    };
    stderr: { write(message: string): void };
  };
  export default process;
}

declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};
