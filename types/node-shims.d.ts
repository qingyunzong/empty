// Minimal ambient declarations for the Node.js built-in modules used by the
// tests, so the project compiles without downloading @types/node.
declare module "node:test" {
  export type TestFn = () => void | Promise<void>;
  export function test(name: string, fn: TestFn): void;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: TestFn): void;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): asserts value;
  export function match(actual: string, regexp: RegExp, message?: string): void;
  export function throws(
    fn: () => unknown,
    matcher?: RegExp | (new (...args: never[]) => Error) | ((err: unknown) => boolean),
    message?: string
  ): void;
  const assert: {
    equal: typeof equal;
    notEqual: typeof notEqual;
    deepEqual: typeof deepEqual;
    ok: typeof ok;
    match: typeof match;
    throws: typeof throws;
  };
  export default assert;
}
