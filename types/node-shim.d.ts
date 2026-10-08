// Minimal ambient declarations for the Node.js APIs used by this project.
// The sandbox has no network access to install @types/node; these cover
// exactly the surface the source and tests touch.

declare var process: {
  argv: string[];
  execPath: string;
  exit(code?: number): never;
  stdout: { write(s: string): boolean };
  stderr: { write(s: string): boolean };
};

declare module "node:assert/strict" {
  interface AssertFn {
    (value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): asserts value;
    throws(fn: () => unknown, expected?: RegExp | (() => unknown), message?: string): void;
    match(value: string, regExp: RegExp, message?: string): void;
  }
  const assert: AssertFn;
  export default assert;
}

declare module "node:test" {
  type TestFn = (name: string, fn: () => void | Promise<void>) => void;
  const test: TestFn;
  export default test;
}

declare module "node:child_process" {
  export function execFileSync(
    file: string,
    args?: readonly string[],
    options?: { encoding?: string },
  ): string;
}
