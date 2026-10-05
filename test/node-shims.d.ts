// Minimal local type declarations for the Node.js built-in modules used by
// the tests (the environment has no @types/node and no network access).
declare module "node:assert/strict" {
  export function ok(value: unknown, message?: string): asserts value;
  export function equal(
    actual: unknown,
    expected: unknown,
    message?: string,
  ): void;
  export function deepEqual(
    actual: unknown,
    expected: unknown,
    message?: string,
  ): void;
  export function throws(
    fn: () => unknown,
    pattern?: RegExp,
    message?: string,
  ): void;
  const assert: {
    ok: typeof ok;
    equal: typeof equal;
    deepEqual: typeof deepEqual;
    throws: typeof throws;
  };
  export default assert;
}

declare module "node:test" {
  export type TestFn = () => void | Promise<void>;
  export default function test(name: string, fn: TestFn): void;
}
