declare module "node:test" {
  export default function test(
    name: string,
    fn: () => void | Promise<void>,
  ): void;
}

declare module "node:assert/strict" {
  interface Assert {
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    throws(
      block: () => unknown,
      validate?: (error: unknown) => boolean,
    ): void;
    doesNotThrow(block: () => unknown, message?: string): void;
    fail(message?: string): never;
    ok(value: unknown, message?: string): asserts value;
  }

  const assert: Assert;
  export default assert;
}

declare const Buffer: {
  from(input: Uint8Array | string): {
    toString(encoding?: string): string;
  };
};
