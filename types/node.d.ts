// Minimal ambient declarations for the Node.js built-in modules used here.
// The environment has no @types/node package, so we declare only what we use.

declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
}

declare module "node:test" {
  export function test(name: string, fn: () => void): void;
}

declare module "node:assert/strict" {
  const assert: {
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    throws(fn: () => void, message?: string): void;
  };
  export default assert;
}

declare const process: {
  argv: string[];
  exit(code?: number): never;
};

declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};
