declare const process: {
  argv: string[];
  exitCode: number;
  cwd(): string;
  exit(code?: number): never;
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
};

declare module "node:fs" {
  export function readFileSync(path: string, encoding: string): string;
  export function writeFileSync(path: string, data: string): void;
  export function writeSync(fd: number, data: string): number;
  export function mkdtempSync(prefix: string): string;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
}

declare module "node:child_process" {
  export interface ExecFileError {
    code?: number | string;
  }
  export function execFile(
    file: string,
    args: string[],
    options: { encoding?: string },
    callback: (err: ExecFileError | null, stdout: string, stderr: string) => void,
  ): void;
}

declare module "node:assert/strict" {
  interface Assert {
    (value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    throws(fn: () => void, message?: string): void;
    doesNotThrow(fn: () => void, message?: string): void;
    match(value: string, regExp: RegExp, message?: string): void;
  }
  const assert: Assert;
  export default assert;
}

declare module "node:test" {
  export default function test(name: string, fn: () => void | Promise<void>): void;
}
