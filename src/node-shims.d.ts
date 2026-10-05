// Minimal typings for the Node.js built-in modules used by the tests, so
// `npm run typecheck` works with zero installed dependencies.
declare module 'node:test' {
  export default function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
}

declare module 'node:assert/strict' {
  interface Assert {
    (value: unknown, message?: string): void;
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    throws(fn: () => unknown, check?: unknown, message?: string): void;
    match(actual: string, expected: RegExp, message?: string): void;
    fail(message?: string): never;
  }
  const assert: Assert;
  export default assert;
}
