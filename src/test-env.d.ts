declare module "node:test" {
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => unknown): void;
}

declare module "node:assert/strict" {
  interface AssertStrict {
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    match(actual: string, regexp: RegExp, message?: string): void;
    rejects(
      asyncFn: (() => Promise<unknown>) | Promise<unknown>,
      error?: unknown,
      message?: string,
    ): Promise<void>;
  }
  const assert: AssertStrict;
  export default assert;
}
