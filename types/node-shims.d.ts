// Minimal type shims for the Node.js built-in modules used by this project.
// The environment has no @types/node and no network access; only the small
// surface we actually call is declared here.

declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function writeFileSync(path: string, data: string): void;
  export function existsSync(path: string): boolean;
  export function mkdtempSync(prefix: string): string;
  export function openSync(path: string, flags: string): number;
  export function closeSync(fd: number): void;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
}

declare module "node:child_process" {
  export interface ChildProcess {
    stdout: { on(event: "data", cb: (data: { toString(): string }) => void): void };
    stderr: { on(event: "data", cb: (data: { toString(): string }) => void): void };
    on(event: "close", cb: (code: number | null) => void): void;
    on(event: "error", cb: (err: Error) => void): void;
  }
  export function spawn(
    file: string,
    args: string[],
    options?: { cwd?: string; stdio?: unknown },
  ): ChildProcess;
}

declare module "node:crypto" {
  export function createHash(algorithm: string): {
    update(data: string): { digest(encoding: "hex"): string };
  };
}

declare module "node:util" {
  export function parseArgs(config: {
    args?: string[];
    allowPositionals?: boolean;
    strict?: boolean;
    options?: Record<
      string,
      { type: "string" | "boolean"; short?: string; multiple?: boolean; default?: string | boolean }
    >;
  }): { values: Record<string, string | boolean | string[] | undefined>; positionals: string[] };
}

declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function throws(fn: () => void, match?: RegExp | ((err: unknown) => boolean)): void;
}

declare module "node:process" {
  const process: {
    argv: string[];
    execPath: string;
    exitCode: number | undefined;
    cwd(): string;
    stdout: { write(data: string): void };
    stderr: { write(data: string): void };
  };
  export default process;
}
