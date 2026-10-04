declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module "node:assert/strict" {
  interface Assert {
    (value: unknown, message?: string): asserts value;
    ok(value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    rejects(
      promise: Promise<unknown>,
      error?: unknown,
      message?: string,
    ): Promise<void>;
  }
  const assert: Assert;
  export default assert;
}

declare function setImmediate(callback: () => void): void;
