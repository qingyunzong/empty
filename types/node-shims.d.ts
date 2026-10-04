// Minimal ambient declarations for the Node.js built-in modules used by the
// tests. The environment has no network access, so @types/node cannot be
// installed; only the small surface we actually use is declared here.
declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => void | Promise<void>): void;
}

declare module "node:assert/strict" {
  interface Assert {
    (value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    notDeepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): asserts value;
    throws(fn: () => unknown, expected?: RegExp | ((err: unknown) => boolean), message?: string): void;
    doesNotThrow(fn: () => unknown, message?: string): void;
    match(actual: string, regexp: RegExp, message?: string): void;
  }
  const assert: Assert;
  export default assert;
}
