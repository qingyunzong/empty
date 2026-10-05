// Minimal ambient declarations for the Node.js built-in modules used by this
// project. The environment has no network access, so @types/node cannot be
// installed; these shims cover exactly the APIs we call.

declare module 'node:fs' {
  export function readFileSync(path: string | number, encoding: 'utf8'): string;
  export function writeFileSync(path: string, data: string): void;
  export function mkdtempSync(prefix: string): string;
  export function existsSync(path: string): boolean;
}

declare module 'node:os' {
  export function tmpdir(): string;
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
}

declare module 'node:util' {
  export interface ParseArgsConfig {
    args?: string[];
    allowPositionals?: boolean;
    strict?: boolean;
    options?: Record<string, { type: 'string' | 'boolean'; multiple?: boolean; default?: string | boolean }>;
  }
  export function parseArgs(config: ParseArgsConfig): {
    values: Record<string, string | boolean | (string | boolean)[] | undefined>;
    positionals: string[];
  };
}

declare module 'node:test' {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
}

declare module 'node:assert/strict' {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): asserts value;
  export function match(actual: string, regexp: RegExp, message?: string): void;
  export function throws(fn: () => void, expected?: RegExp | ((err: unknown) => boolean), message?: string): void;
}

declare module 'node:child_process' {
  export interface ChildProcess {
    stdout: { on(event: 'data', cb: (chunk: { toString(): string }) => void): void } | null;
    stderr: { on(event: 'data', cb: (chunk: { toString(): string }) => void): void } | null;
    stdin: { end(data?: string): void } | null;
    on(event: 'close', cb: (code: number | null) => void): void;
    on(event: 'error', cb: (err: Error) => void): void;
  }
  export function spawn(file: string, args: string[], options?: { stdio?: unknown[] }): ChildProcess;
}

declare module 'node:process' {
  export const argv: string[];
  export const env: Record<string, string | undefined>;
  export const execPath: string;
  export let exitCode: number | undefined;
  export const stdin: { fd: number };
  export const stdout: { write(chunk: string): boolean };
  export const stderr: { write(chunk: string): boolean };
  export function exit(code?: number): never;
}
