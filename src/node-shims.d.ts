// Minimal type declarations for the Node.js built-ins used by this project.
// The environment has no @types/node and no network access; these cover only
// what the code touches. Runtime uses Node built-in modules exclusively.

declare module "node:fs" {
  export function readFileSync(path: string, encoding: string): string;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
}

declare module "node:test" {
  export function test(name: string, fn: () => void): void;
}

declare module "node:assert/strict" {
  interface Assert {
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    throws(fn: () => void, pattern?: RegExp): void;
  }
  const assert: Assert;
  export default assert;
}

declare const __dirname: string;

declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

declare const process: {
  argv: string[];
  cwd(): string;
  exit(code?: number): never;
  hrtime: { bigint(): bigint };
};
