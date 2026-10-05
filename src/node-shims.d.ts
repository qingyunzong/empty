// Minimal offline type declarations for the Node.js built-ins used here,
// so the project compiles without downloading @types/node.

declare var __dirname: string;

declare var require: { main: unknown };
declare var module: unknown;

declare var process: {
  argv: string[];
  execPath: string;
  exit(code?: number): never;
};

declare module "node:fs" {
  export function readFileSync(path: string, encoding: string): string;
}

declare module "node:util" {
  interface ParseArgsOption {
    type: "string" | "boolean";
    default?: string | boolean;
  }
  export function parseArgs(config: {
    args?: string[];
    options?: Record<string, ParseArgsOption>;
  }): { values: Record<string, string | boolean | undefined> };
}

declare module "node:path" {
  export function join(...parts: string[]): string;
}

declare module "node:test" {
  export function test(name: string, fn: () => void): void;
}

declare module "node:assert/strict" {
  const assert: {
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
  };
  export default assert;
}

declare module "node:child_process" {
  export function execFileSync(
    file: string,
    args: string[],
    options: { encoding: string },
  ): string;
}
