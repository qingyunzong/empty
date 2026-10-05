// Minimal ambient declarations for the Node.js built-ins used here.
// The sandbox has no network access, so @types/node cannot be installed;
// only the exact surface this project relies on is declared.

declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function writeFileSync(path: string, data: string): void;
}

declare module "node:assert/strict" {
  interface Assert {
    (value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): asserts value;
    throws(fn: () => unknown, check?: (err: unknown) => boolean, message?: string): void;
  }
  const assert: Assert;
  export default assert;
}

declare module "node:test" {
  export default function test(name: string, fn: () => void): void;
}

declare const process: {
  argv: string[];
  exit(code?: number): never;
};

declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};
