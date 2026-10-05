declare module "node:test" {
  export type TestHandler = () => void | Promise<void>;
  export default function test(name: string, fn: TestHandler): void;
}

declare module "node:assert/strict" {
  interface AssertStrict {
    (value: unknown, message?: string): asserts value;
    ok(value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    notDeepEqual(actual: unknown, expected: unknown, message?: string): void;
    throws(fn: () => unknown, error?: unknown, message?: string): void;
    doesNotThrow(fn: () => unknown, message?: string): void;
    match(actual: string, regexp: RegExp, message?: string): void;
  }
  const assert: AssertStrict;
  export default assert;
}
