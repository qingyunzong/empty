// Minimal type declarations for the Node.js built-in APIs used by this
// project. Runtime uses only Node built-ins; this file exists because
// @types/node cannot be installed in the offline environment.

declare module "node:fs" {
  export function readFileSync(path: string, encoding: string): string;
  export function writeFileSync(path: string, data: string): void;
  export function mkdtempSync(prefix: string): string;
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
    options: { encoding: string },
  ): string;
}

declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module "node:assert/strict" {
  interface Assert {
    (value: unknown, message?: string): void;
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    match(value: string, pattern: RegExp, message?: string): void;
    throws(fn: () => void, pattern?: RegExp): void;
  }
  const assert: Assert;
  export default assert;
}

declare var process: {
  argv: string[];
  execPath: string;
  exit(code?: number): never;
};

declare module "node:url" {
  export function pathToFileURL(path: string): URL;
}
