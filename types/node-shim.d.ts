// Minimal Node.js type declarations (offline environment, no @types/node).
declare module 'node:fs' {
  export function writeFileSync(path: string, data: string): void;
  export function readFileSync(path: string, encoding: string): string;
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, opts?: { recursive?: boolean }): void;
  export function rmSync(path: string, opts?: { recursive?: boolean; force?: boolean }): void;
}
declare module 'node:test' {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
}
declare module 'node:assert/strict' {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function throws(fn: () => void, message?: string): void;
}
declare module 'node:path' {
  export function join(...parts: string[]): string;
}
declare module 'node:os' {
  export function tmpdir(): string;
}
declare const process: {
  argv: string[];
  exitCode: number | undefined;
  stdout: { write(s: string): void };
  stderr: { write(s: string): void };
};
