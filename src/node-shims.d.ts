// Minimal ambient declarations for the Node.js built-ins used by this
// project, so the repo builds offline with zero external dependencies.
declare module "node:test" {
  export type TestFn = () => void | Promise<void>;
  export function test(name: string, fn: TestFn): void;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: TestFn): void;
}
declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function throws(fn: () => unknown, expected?: RegExp | ((err: unknown) => boolean), message?: string): void;
  export function fail(message?: string): never;
}
declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function writeFileSync(path: string, data: string): void;
  export function existsSync(path: string): boolean;
}
declare module "node:child_process" {
  export function execFileSync(file: string, args: string[], options: { encoding: "utf8" }): string;
  export interface ChildProcess {
    stdout: { on(event: "data", cb: (chunk: unknown) => void): void };
    stderr: { on(event: "data", cb: (chunk: unknown) => void): void };
    on(event: "close", cb: (code: number | null) => void): void;
    on(event: "error", cb: (err: Error) => void): void;
  }
  export function spawn(file: string, args: string[]): ChildProcess;
}
declare const process: {
  argv: string[];
  exitCode: number | undefined;
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
};
declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};
