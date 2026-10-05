// Minimal ambient declarations for Node.js built-in test modules,
// so the project stays dependency-free (no @types/node required).
declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

declare module 'node:test' {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
  const testFn: typeof test & { describe: typeof describe };
  export default testFn;
}

declare module 'node:assert/strict' {
  export function ok(value: unknown, message?: string): asserts value;
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function throws(
    fn: () => unknown,
    expected?: RegExp | (new (...args: never[]) => Error) | ((err: unknown) => boolean),
    message?: string
  ): void;
  const assert: {
    ok: typeof ok;
    equal: typeof equal;
    notEqual: typeof notEqual;
    deepEqual: typeof deepEqual;
    throws: typeof throws;
  };
  export default assert;
}
