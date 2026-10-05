// Minimal ambient declarations for the Node.js built-in modules used by this
// project. The environment has no network access, so @types/node cannot be
// installed; only the small surface we actually use is declared here.

declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
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

declare module "node:process" {
  const process: {
    argv: string[];
    exitCode: number | undefined;
    stdout: { write(chunk: string): boolean };
    stderr: { write(chunk: string): boolean };
  };
  export default process;
}

declare module "node:test" {
  type TestFn = () => void | Promise<void>;
  export function test(name: string, fn: TestFn): void;
  export function describe(name: string, fn: () => void): void;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): asserts value;
  export function match(actual: string, regexp: RegExp, message?: string): void;
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
    options: { encoding: "utf8" }
  ): SpawnResult;
}

declare module "node:url" {
  export function fileURLToPath(url: string): string;
}
