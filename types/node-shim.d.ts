// Minimal ambient declarations for the Node.js built-in modules used by the
// tests, so the project compiles with zero external dependencies.
declare module "node:test" {
  export type TestFn = () => void | Promise<void>;
  export function test(name: string, fn: TestFn): void;
  export function describe(name: string, fn: () => void): void;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): asserts value;
  export function throws(fn: () => unknown, matcher?: RegExp | ((err: unknown) => boolean), message?: string): void;
  export function match(actual: string, matcher: RegExp, message?: string): void;
  const assert: {
    equal: typeof equal;
    deepEqual: typeof deepEqual;
    ok: typeof ok;
    throws: typeof throws;
    match: typeof match;
  };
  export default assert;
}

declare var process: {
  env: Record<string, string | undefined>;
};
