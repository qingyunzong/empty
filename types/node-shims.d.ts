// Minimal offline shims for the Node.js built-in modules used by this project.
// The project intentionally has no npm dependencies (including @types/node).

declare module "node:process" {
  interface Process {
    argv: string[];
    execPath: string;
    exitCode: number | undefined;
    stdin: { isTTY: boolean };
    stdout: { write(chunk: string): boolean };
    stderr: { write(chunk: string): boolean };
    exit(code?: number): never;
  }
  const process: Process;
  export default process;
}

declare module "node:fs" {
  export function readFileSync(path: string | number, encoding: "utf8"): string;
  export function readFileSync(path: string | number): Uint8Array;
}

declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
}

declare module "node:assert/strict" {
  export function ok(value: unknown, message?: string): void;
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepStrictEqual(actual: unknown, expected: unknown, message?: string): void;
  export function throws(
    fn: () => unknown,
    expected?: RegExp | (new (...args: never[]) => Error) | ((err: unknown) => boolean),
    message?: string,
  ): void;
}

declare module "node:url" {
  export function fileURLToPath(url: string): string;
}

interface ImportMeta {
  url: string;
}
