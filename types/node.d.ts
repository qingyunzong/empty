// Minimal ambient declarations for the Node.js built-in modules used by this
// project. The environment has no network access to install @types/node, and
// the project intentionally depends only on Node.js built-in libraries.

declare module "node:fs" {
  export function readFileSync(path: string | number, encoding: "utf8"): string;
  export function writeFileSync(path: string, data: string): void;
}

declare module "node:process" {
  interface Process {
    argv: string[];
    execPath: string;
    pid: number;
    exitCode: number | undefined;
    stdin: { setEncoding(enc: string): void; on(event: string, cb: (chunk?: unknown) => void): void };
    stdout: { write(s: string): void };
    stderr: { write(s: string): void };
  }
  const process: Process;
  export default process;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function fail(message?: string): never;
  export function throws(fn: () => void, pattern?: RegExp): void;
}

declare module "node:test" {
  type TestFn = () => void | Promise<void>;
  export function test(name: string, fn: TestFn): void;
  export function describe(name: string, fn: () => void): void;
}

declare module "node:child_process" {
  export function execFileSync(
    file: string,
    args: string[],
    options: { input?: string; encoding: "utf8" }
  ): string;
  export function spawnSync(
    file: string,
    args: string[],
    options: { input?: string; encoding: "utf8" }
  ): { status: number | null; stdout: string; stderr: string };
}

declare module "node:path" {
  export function dirname(p: string): string;
  export function join(...parts: string[]): string;
}

declare module "node:url" {
  export function fileURLToPath(url: string): string;
}

interface ImportMeta {
  url: string;
}
