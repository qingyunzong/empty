// Minimal ambient declarations for the Node.js built-in modules used by the
// test suite. The project has no external dependencies, so these stand in for
// @types/node (only the actually-used surface is declared).

declare module 'node:test' {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function test(fn: () => void | Promise<void>): void;
}

declare module 'node:assert/strict' {
  export function ok(value: unknown, message?: string): asserts value;
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function throws(
    fn: () => unknown,
    error?: RegExp | (new (...args: any[]) => Error) | ((err: unknown) => boolean),
    message?: string,
  ): void;
  export function unreachable(message?: string): never;
  const assert: {
    ok: typeof ok;
    equal: typeof equal;
    deepEqual: typeof deepEqual;
    throws: typeof throws;
    unreachable: typeof unreachable;
  };
  export default assert;
}
