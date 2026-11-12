declare module "node:test" {
  export default function test(
    name: string,
    fn: () => void | Promise<void>,
  ): void;
}

declare module "node:assert/strict" {
  interface Assert {
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): asserts value;
    rejects(
      promise: PromiseLike<unknown>,
      validator?: (error: unknown) => boolean,
    ): Promise<void>;
  }

  const assert: Assert;
  export default assert;
}
