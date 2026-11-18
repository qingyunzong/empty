declare const process: {
  env: Record<string, string | undefined>;
};

declare module 'node:test' {
  export interface TestContext {
    name: string;
  }

  export default function test(
    name: string,
    fn: (context: TestContext) => void | Promise<void>,
  ): void;
}

declare module 'node:assert/strict' {
  interface Assert {
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): asserts value;
    throws(fn: () => unknown, expected?: unknown, message?: string): void;
  }

  const assert: Assert;
  export default assert;
}
