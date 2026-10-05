/**
 * Minimal ambient declarations for the Node.js built-ins used by this project.
 * The project intentionally has zero npm dependencies (including @types/node),
 * so only the exact APIs we use are declared here.
 */

declare var process: {
  argv: string[];
  exit(code?: number): never;
  stdout: { write(s: string): boolean };
  stderr: { write(s: string): boolean };
  cwd(): string;
};

declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function writeFileSync(path: string, data: string): void;
  export function mkdtempSync(prefix: string): string;
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
}

declare module 'node:os' {
  export function tmpdir(): string;
}

declare module 'node:child_process' {
  export interface SpawnResult {
    status: number | null;
    stdout: string;
    stderr: string;
  }
  export function spawnSync(
    cmd: string,
    args: string[],
    opts?: { encoding?: 'utf8'; input?: string },
  ): SpawnResult;
}

declare module 'node:test' {
  export type TestFn = () => void | Promise<void>;
  export function test(name: string, fn: TestFn): void;
  export function describe(name: string, fn: () => void): void;
}

declare module 'node:assert/strict' {
  export function equal(a: unknown, b: unknown, msg?: string): void;
  export function notEqual(a: unknown, b: unknown, msg?: string): void;
  export function deepEqual(a: unknown, b: unknown, msg?: string): void;
  export function ok(v: unknown, msg?: string): asserts v;
  export function match(s: string, re: RegExp, msg?: string): void;
  export function throws(fn: () => void, match?: RegExp | ((e: Error) => boolean)): void;
}
