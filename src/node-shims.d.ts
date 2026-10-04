// Minimal declarations for Node.js built-ins used by this project,
// so `tsc` works without @types/node (offline environment).
declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
  export default test;
}
declare module "node:assert/strict" {
  export function equal(a: unknown, b: unknown, msg?: string): void;
  export function deepEqual(a: unknown, b: unknown, msg?: string): void;
  export function ok(v: unknown, msg?: string): void;
  export function throws(fn: () => void, re?: RegExp): void;
  export function match(s: string, re: RegExp): void;
}
declare module "node:fs" {
  export function readFileSync(path: string, enc: string): string;
  export function writeFileSync(path: string, data: string): void;
}
declare module "node:process" {
  const process: {
    argv: string[];
    exitCode: number | undefined;
    stdout: { write(s: string): void };
    stderr: { write(s: string): void };
  };
  export default process;
}
declare var console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};
