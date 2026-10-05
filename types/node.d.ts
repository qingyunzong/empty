// Minimal ambient declarations for the Node.js built-ins this project uses.
// The environment has no @types/node and no network access; only the APIs
// actually consumed by src/ and test/ are declared here.

declare var console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

declare var process: {
  argv: string[];
  exit(code?: number): never;
};

declare module "node:test" {
  type TestFn = () => void | Promise<void>;
  interface Test {
    (name: string, fn: TestFn): void;
  }
  const test: Test;
  export default test;
}

declare module "node:assert/strict" {
  const assert: {
    ok(value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    throws(fn: () => unknown, pattern?: RegExp, message?: string): void;
  };
  export default assert;
}

declare module "node:fs/promises" {
  export function readFile(path: string, encoding: "utf8"): Promise<string>;
}

declare module "node:util" {
  export function parseArgs(config: {
    options: Record<string, { type: "string" | "boolean" }>;
  }): { values: Record<string, string | undefined> };
}
