// Minimal ambient declarations for the Node.js built-ins used by this project.
// The project intentionally has zero npm dependencies, so @types/node is not installed.

declare const process: {
  argv: string[];
  exitCode: number | undefined;
  stdout: { write(s: string): void };
  stderr: { write(s: string): void };
};

declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
}

declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
}

declare module "node:assert/strict" {
  export function equal(a: unknown, b: unknown, msg?: string): void;
  export function notEqual(a: unknown, b: unknown, msg?: string): void;
  export function deepEqual(a: unknown, b: unknown, msg?: string): void;
  export function ok(v: unknown, msg?: string): void;
  export function throws(fn: () => void, pattern?: RegExp): void;
}
