// The harness image intentionally ships without @types/node. These minimal
// declarations keep the test sources typecheckable; runtime types come from
// Node itself.
declare module "node:test" {
  const test: (
    name: string,
    fn: () => void | Promise<void>,
  ) => void;
  export default test;
}

declare module "node:assert/strict" {
  const assert: {
    (value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    throws(fn: () => unknown, expected?: unknown, message?: string): void;
    rejects(
      fn: (() => Promise<unknown>) | Promise<unknown>,
      expected?: unknown,
      message?: string,
    ): Promise<void>;
  };
  export default assert;
}
