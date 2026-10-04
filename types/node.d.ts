// Minimal ambient declarations for the Node.js built-in modules used here.
// The sandbox has no network access to install @types/node, and the project
// only uses Node built-ins, so the required surface is declared locally.

declare module "node:fs" {
  export function readFileSync(path: string | number, encoding: string): string;
  export function writeFileSync(path: string, data: string): void;
  export function mkdtempSync(prefix: string): string;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
}

declare module "node:url" {
  export function fileURLToPath(url: URL | string): string;
}

declare module "node:child_process" {
  export function execFileSync(
    file: string,
    args: string[],
    options: { input?: string | undefined; encoding: string; stdio?: unknown },
  ): string;
}

declare module "node:test" {
  export function test(name: string, fn: () => void): void;
}

declare module "node:assert/strict" {
  interface Assert {
    (value: unknown, message?: string): asserts value;
    ok(value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    throws(fn: () => void, expected?: unknown, message?: string): void;
  }
  const assert: Assert;
  export default assert;
}

declare var process: {
  argv: string[];
  exit(code?: number): never;
};

declare var console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};
