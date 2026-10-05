// Minimal ambient declarations for the Node.js built-in modules used by the
// tests. The environment has no network access to fetch @types/node; only
// the actually used surface is declared here.
declare module 'node:test' {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module 'node:assert/strict' {
  interface Assert {
    (value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): asserts value;
  }
  const assert: Assert;
  export default assert;
}
