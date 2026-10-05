// Minimal ambient declarations for the Node.js built-ins used by this
// project. The environment has no @types/node and no network access, so we
// declare exactly what we use instead of adding a dependency.

declare module "node:fs" {
  export function readFileSync(path: string | number, encoding: "utf8"): string;
  export function writeFileSync(path: string, data: string): void;
  export function openSync(path: string, flags: "r" | "w"): number;
  export function closeSync(fd: number): void;
  export function unlinkSync(path: string): void;
}

declare module "node:child_process" {
  export function spawnSync(
    file: string,
    args: string[],
    options?: { stdio?: Array<number | "ignore" | "inherit"> }
  ): { status: number | null; error?: Error };
}

declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function throws(
    fn: () => void,
    expected?: RegExp | (new (...args: never[]) => Error)
  ): void;
}

declare const process: {
  argv: string[];
  pid: number;
  exitCode: number | undefined;
  stdin: { fd: number };
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
};

declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};
