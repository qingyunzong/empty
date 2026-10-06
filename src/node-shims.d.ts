// Minimal ambient declarations for the Node.js APIs used by this project.
// The sandbox has no network access, so @types/node cannot be installed.

declare module "node:process" {
  const process: {
    argv: string[];
    exitCode?: number;
    exit(code?: number): never;
    stdout: { write(chunk: string): boolean };
    stderr: { write(chunk: string): boolean };
  };
  export default process;
}

declare module "node:fs" {
  export function readFileSync(path: string | number, encoding: "utf8"): string;
  export function writeFileSync(path: string, data: string): void;
  export function unlinkSync(path: string): void;
}

declare module "node:test" {
  function test(name: string, fn: () => void | Promise<void>): void;
  export default test;
}

declare module "node:assert/strict" {
  const assert: {
    (value: unknown, message?: string): void;
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    throws(
      fn: () => unknown,
      check?: RegExp | ((err: unknown) => boolean) | (new (...args: never[]) => Error),
      message?: string,
    ): void;
    match(value: string, regExp: RegExp, message?: string): void;
  };
  export default assert;
}

declare module "node:child_process" {
  export function spawnSync(
    file: string,
    args: string[],
    options?: { encoding?: "utf8"; input?: string }
  ): { status: number | null; stdout: string; stderr: string };
}

interface ImportMeta {
  url: string;
}

declare const URL: {
  new (url: string, base?: string): { pathname: string; href: string };
};
