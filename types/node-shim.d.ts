// Minimal offline type declarations for the Node.js APIs used by this
// project (the sandbox has no network access to fetch @types/node).

declare var console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

declare var process: {
  argv: string[];
  exitCode: number | undefined;
  cwd(): string;
  stdout: { write(s: string): void };
  stderr: { write(s: string): void };
};

declare module 'node:crypto' {
  export function createHash(algorithm: string): {
    update(data: string): { digest(encoding: 'hex'): string };
  };
}

declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function writeFileSync(path: string, data: string): void;
  export function mkdtempSync(prefix: string): string;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
}

declare module 'node:os' {
  export function tmpdir(): string;
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
}

declare module 'node:child_process' {
  export interface ExecFileSyncOptions {
    encoding?: 'utf8';
    cwd?: string;
  }
  export function execFileSync(file: string, args?: string[], options?: ExecFileSyncOptions): string;
}

declare module 'node:test' {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
}

declare module 'node:assert/strict' {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): asserts value;
  export function throws(fn: () => void, match?: RegExp | ((e: Error) => boolean)): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
}
