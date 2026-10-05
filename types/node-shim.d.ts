// Minimal ambient declarations for the Node.js built-in modules used by the
// tests, so the project compiles without downloading @types/node.
declare module "node:test" {
  export type TestFn = () => void | Promise<void>;
  export function test(name: string, fn: TestFn): void;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: TestFn): void;
}

declare module "node:assert/strict" {
  interface Assert {
    (value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    strictEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): asserts value;
    fail(message?: string): never;
    match(actual: string, regexp: RegExp, message?: string): void;
    throws(fn: () => unknown, matcher?: unknown, message?: string): void;
    doesNotThrow(fn: () => unknown, message?: string): void;
  }
  const assert: Assert;
  export default assert;
}
