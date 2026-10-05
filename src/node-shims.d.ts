// Minimal ambient declarations for the Node.js built-ins used by this project.
// The environment has no @types/node and no network access; only built-in
// modules are used at runtime, so these shims cover exactly what we touch.

declare const process: {
  argv: string[];
  exitCode: number | undefined;
  cwd(): string;
  stdout: { write(s: string): void };
  stderr: { write(s: string): void };
};

declare module "node:fs" {
  export function readFileSync(path: string, encoding: string): string;
  export function writeFileSync(path: string, data: string): void;
}

declare module "node:path" {
  export function resolve(...parts: string[]): string;
}

declare module "node:test" {
  export function test(name: string, fn: () => void): void;
  export function describe(name: string, fn: () => void): void;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function throws(fn: () => void, expected?: RegExp | ((err: unknown) => boolean)): void;
  const assert: {
    equal: typeof equal;
    notEqual: typeof notEqual;
    deepEqual: typeof deepEqual;
    ok: typeof ok;
    throws: typeof throws;
  };
  export default assert;
}

declare module "node:child_process" {
  export function execFileSync(file: string, args: string[], options?: { encoding?: string }): string;
}

declare const require: {
  (id: string): unknown;
  main: unknown;
};
declare const module: unknown;
