// Minimal ambient declarations for the Node test runner (no @types/node
// available offline). Only the surface used by the tests is declared.
declare module 'node:test' {
  function test(name: string, fn: () => unknown): void;
  export default test;
}

declare module 'node:assert/strict' {
  interface Assert {
    (value: unknown, message?: string): void;
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
  }
  const assert: Assert;
  export default assert;
}
