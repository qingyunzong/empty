declare module "node:test" {
  export type TestFn = () => void | Promise<void>;
  export function test(name: string, fn: TestFn): void;
}

declare module "node:assert/strict" {
  const assert: {
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    throws(fn: () => void, message?: string): void;
    match(value: string, pattern: RegExp, message?: string): void;
  };
  export default assert;
}

declare module "node:fs" {
  export function readFileSync(path: string | number, encoding: "utf8"): string;
  export function writeFileSync(path: string, data: string): void;
  export function openSync(path: string, flags: string): number;
  export function closeSync(fd: number): void;
}

declare module "node:process" {
  const process: {
    argv: string[];
    pid: number;
    exitCode: number | undefined;
    stdout: { write(chunk: string): void };
    stderr: { write(chunk: string): void };
  };
  export default process;
}

declare module "node:child_process" {
  export interface SpawnResult {
    status: number | null;
    stdout: string;
    stderr: string;
    error?: { message: string };
  }
  export function spawnSync(
    file: string,
    args: string[],
    options: { encoding?: "utf8"; stdio?: [number | "ignore", number | "ignore", number | "ignore"] }
  ): SpawnResult;
}
