declare module 'node:test' {
  type TestFn = () => void | Promise<void>;
  interface Test {
    (name: string, fn: TestFn): void;
  }
  const test: Test;
  export default test;
}

declare module 'node:assert/strict' {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function strictEqual(actual: unknown, expected: unknown, message?: string): void;
  export function notStrictEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepStrictEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): asserts value;
  export function match(value: string, regExp: RegExp, message?: string): void;
  const assert: {
    equal: typeof equal;
    strictEqual: typeof strictEqual;
    notStrictEqual: typeof notStrictEqual;
    deepStrictEqual: typeof deepStrictEqual;
    ok: typeof ok;
    match: typeof match;
  };
  export default assert;
}
