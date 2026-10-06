declare const process: {
  argv: string[];
  execPath: string;
  exit(code?: number): never;
  exitCode: number | undefined;
  cwd(): string;
  env: Record<string, string | undefined>;
};

declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

declare module "node:test" {
  export function test(name: string, fn: () => unknown): void;
  export function describe(name: string, fn: () => void): void;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function throws(fn: () => unknown, match?: RegExp): void;
}

declare module "node:fs" {
  export function readFileSync(path: string, encoding: string): string;
  export function writeFileSync(path: string, data: string): void;
  export function existsSync(path: string): boolean;
  export function mkdtempSync(prefix: string): string;
  export function rmSync(path: string, opts?: { force?: boolean }): void;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
}

declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
}

declare module "node:child_process" {
  export function spawnSync(
    cmd: string,
    args: string[],
    opts?: { cwd?: string; encoding?: string }
  ): { status: number | null; stdout: string; stderr: string };
}
