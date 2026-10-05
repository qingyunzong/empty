// Minimal ambient declarations for the Node.js built-ins used by this
// project. The environment has no registry access, so @types/node cannot be
// installed; only the small surface we actually use is declared here.

declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

declare module "node:fs" {
  export function readFileSync(path: string | number, encoding: "utf8"): string;
  export function writeFileSync(path: string, data: string): void;
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
  export function execFileSync(
    file: string,
    args: string[],
    options?: { input?: string; encoding?: "utf8" }
  ): string;
  export interface ChildProcess {
    on(event: "error", cb: (err: Error) => void): void;
    on(event: "close", cb: (code: number | null) => void): void;
  }
  export function spawn(
    file: string,
    args: string[],
    options?: { stdio?: Array<string | number> }
  ): ChildProcess;
}

declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
}

declare module "node:assert/strict" {
  export function ok(value: unknown, message?: string): void;
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function throws(
    fn: () => void,
    expected?: RegExp | ((err: unknown) => boolean) | (new (...args: never[]) => Error),
    message?: string
  ): void;
  export function fail(message?: string): never;
}
