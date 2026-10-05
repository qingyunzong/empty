declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

declare module "node:test" {
  type TestFn = () => void | Promise<void>;
  interface Test {
    (name: string, fn: TestFn): void;
    skip(name: string, fn: TestFn): void;
  }
  const test: Test;
  export default test;
  export { test };
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function throws(fn: () => void, message?: string): void;
}

declare module "node:process" {
  const process: {
    argv: string[];
    exitCode: number | undefined;
    cwd(): string;
  };
  export default process;
}

declare module "node:fs" {
  export function readFileSync(path: string, encoding: string): string;
}
