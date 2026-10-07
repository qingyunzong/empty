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
  export function throws(
    fn: () => unknown,
    check?: RegExp | ((err: unknown) => boolean),
    message?: string
  ): void;
}

declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
}

declare const process: {
  argv: string[];
  exitCode: number | undefined;
};

declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};
