declare module "node:test" {
  type TestFn = () => void | Promise<void>;
  const test: (name: string, fn: TestFn) => void;
  export default test;
}

declare module "node:assert/strict" {
  interface AssertStrict {
    ok(value: unknown, message?: string | Error): void;
    equal(actual: unknown, expected: unknown, message?: string | Error): void;
    throws(fn: () => unknown, error?: unknown, message?: string | Error): void;
  }
  const assert: AssertStrict;
  export default assert;
}
