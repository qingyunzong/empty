// Minimal ambient declarations for the Node.js built-in modules used by the
// tests, so `tsc --noEmit` passes without installing @types/node.
declare module "node:test" {
  export type TestFn = () => void | Promise<void>;
  export function test(name: string, fn: TestFn): void;
  export function test(name: string, options: Record<string, unknown>, fn: TestFn): void;
}

declare module "node:assert/strict" {
  const assert: {
    (value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): asserts value;
    throws(fn: () => unknown, expected?: unknown, message?: string): void;
  };
  export default assert;
}
