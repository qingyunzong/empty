// Minimal type declarations for the Node.js built-in modules used by this
// project. The sandbox has no network access, so @types/node cannot be
// installed; only the small surface we actually use is declared here.

declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

declare class URL {
  constructor(url: string, base?: string | URL);
  toString(): string;
}

interface ImportMeta {
  url: string;
}

declare module "node:fs" {
  export function readFileSync(path: string | number, encoding: string): string;
}

declare module "node:process" {
  interface Process {
    argv: string[];
    execPath: string;
    exitCode: number | undefined;
    cwd(): string;
    stdout: { write(chunk: string): boolean };
    stderr: { write(chunk: string): boolean };
  }
  const process: Process;
  export default process;
}

declare module "node:test" {
  export type TestFn = () => void | Promise<void>;
  export function test(name: string, fn: TestFn): void;
  export function describe(name: string, fn: () => void): void;
  export default test;
}

declare module "node:assert/strict" {
  export function ok(value: unknown, message?: string): asserts value;
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function strictEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepStrictEqual(actual: unknown, expected: unknown, message?: string): void;
  export function throws(fn: () => unknown, message?: string): void;
  export function match(actual: string, regexp: RegExp, message?: string): void;
  const assert: {
    ok(value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    strictEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    deepStrictEqual(actual: unknown, expected: unknown, message?: string): void;
    throws(fn: () => unknown, message?: string): void;
    match(actual: string, regexp: RegExp, message?: string): void;
  };
  export default assert;
}
