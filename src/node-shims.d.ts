// Minimal ambient declarations for the Node.js built-ins we use.
// The environment has no @types/node and network installs are unavailable,
// so we declare exactly the surface this project relies on.

declare class URL {
  constructor(url: string, base?: string);
  protocol: string;
  hostname: string;
  port: string;
  toString(): string;
}

declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

declare const process: {
  argv: string[];
  exitCode: number | undefined;
  exit(code?: number): never;
  cwd(): string;
  pid: number;
  execPath: string;
};

declare module "node:fs" {
  export function readFileSync(path: string | number, encoding: "utf8"): string;
  export function writeFileSync(path: string, data: string): void;
  export function openSync(path: string, flags: string): number;
  export function closeSync(fd: number): void;
  export function unlinkSync(path: string): void;
}

declare module "node:child_process" {
  export interface ChildProcess {
    stdin: { end(data?: string): void };
    on(event: "close", listener: (code: number | null) => void): void;
    on(event: "error", listener: (err: Error) => void): void;
  }
  export function spawn(
    command: string,
    args: string[],
    options?: { stdio?: unknown[] }
  ): ChildProcess;
}

declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
  export default test;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function throws(fn: () => unknown, message?: string): void;
  export function match(value: string, regExp: RegExp, message?: string): void;
  const assert: {
    equal: typeof equal;
    notEqual: typeof notEqual;
    deepEqual: typeof deepEqual;
    ok: typeof ok;
    throws: typeof throws;
    match: typeof match;
  };
  export default assert;
}
