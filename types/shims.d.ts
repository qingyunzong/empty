declare const process: {
  argv: string[];
  exitCode: number | undefined;
  cwd(): string;
  exit(code?: number): never;
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
};

declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

declare const module: { id: string };

declare const require: { main?: { id: string } };

declare module "node:fs" {
  export function readFileSync(path: string | number, encoding: string): string;
  export function writeFileSync(path: string, data: string): void;
  export function unlinkSync(path: string): void;
}

declare module "node:child_process" {
  export function execFileSync(
    file: string,
    args: string[],
    options: { input?: string; encoding: string; cwd?: string }
  ): string;
}

declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module "node:assert/strict" {
  interface Assert {
    (value: unknown, message?: string): void;
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    throws(fn: () => unknown, message?: string): void;
  }
  const assert: Assert;
  export default assert;
}
