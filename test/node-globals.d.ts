declare module 'node:test' {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module 'node:assert/strict' {
  interface Assert {
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    rejects(
      promise: Promise<unknown>,
      error?: new (...args: never[]) => Error,
    ): Promise<void>;
  }
  const assert: Assert;
  export default assert;
}
