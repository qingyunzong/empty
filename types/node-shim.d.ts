// Minimal ambient declarations for the Node.js built-in modules used by the
// tests, so the project compiles without downloading @types/node.
declare module 'node:assert/strict' {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function match(actual: string, regexp: RegExp, message?: string): void;
  export function throws(fn: () => unknown, error?: RegExp | Error, message?: string): void;
  export function rejects(
    fn: () => Promise<unknown>,
    error?: RegExp | Error,
    message?: string,
  ): Promise<void>;
  const assert: {
    equal: typeof equal;
    deepEqual: typeof deepEqual;
    match: typeof match;
    throws: typeof throws;
    rejects: typeof rejects;
  };
  export default assert;
}

declare module 'node:test' {
  type TestFn = () => void | Promise<void>;
  export default function test(name: string, fn: TestFn): void;
}
