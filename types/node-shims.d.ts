// Minimal offline type shims for the Node.js built-ins used by this project.
// The environment has no @types/node installed, so only the exact surface
// we rely on is declared here.

declare const Buffer: {
  from(data: string, encoding: 'utf8'): Uint8Array;
  compare(a: Uint8Array, b: Uint8Array): number;
};

declare module 'node:test' {
  type TestFn = () => void | Promise<void>;
  interface Test {
    (name: string, fn: TestFn): void;
  }
  const test: Test;
  export default test;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: TestFn): void;
}

declare module 'node:assert/strict' {
  interface Assert {
    (value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    match(actual: string, regexp: RegExp, message?: string): void;
  }
  const assert: Assert;
  export default assert;
}
