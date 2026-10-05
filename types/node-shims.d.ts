// Minimal ambient declarations for the Node built-ins used by this project.
// The environment has no network access, so @types/node cannot be installed;
// these shims cover exactly the APIs exercised by the tests and demo.

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): asserts value;
  export function match(actual: string, regexp: RegExp, message?: string): void;
  export function throws(
    fn: () => unknown,
    expected?: RegExp | (new (...args: never[]) => Error) | ((err: unknown) => boolean),
    message?: string,
  ): void;
  export function doesNotThrow(fn: () => unknown, message?: string): void;
}

declare module "node:test" {
  type TestFn = () => void | Promise<void>;
  export function test(name: string, fn: TestFn): void;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: TestFn): void;
}

declare module "node:process" {
  const process: {
    argv: string[];
    exitCode?: number;
    stdout: { write(s: string): void };
  };
  export default process;
}

declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};
