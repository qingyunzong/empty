// Minimal ambient declarations for the Node.js built-ins used by this
// project. The environment has no @types/node package available, so only
// the small surface we actually touch is declared here.

declare const process: {
  argv: string[];
  execPath: string;
  exitCode: number | undefined;
  cwd(): string;
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
};

declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function match(actual: string, expected: RegExp, message?: string): void;
  export function throws(fn: () => void, expected?: RegExp | (abstract new (...args: never[]) => unknown), message?: string): void;
  const _default: {
    equal: typeof equal;
    deepEqual: typeof deepEqual;
    ok: typeof ok;
    match: typeof match;
    throws: typeof throws;
  };
  export default _default;
}
