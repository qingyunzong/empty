/**
 * Minimal ambient declarations for the Node.js built-in modules used by
 * this project. The offline environment has no @types/node; only the
 * actually-used surface is declared here.
 */

declare module 'node:test' {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
}

declare module 'node:assert/strict' {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function throws(fn: () => unknown, expected?: RegExp | (new (...args: never[]) => Error), message?: string): void;
  const assert: {
    equal: typeof equal;
    deepEqual: typeof deepEqual;
    ok: typeof ok;
    throws: typeof throws;
  };
  export default assert;
}

declare module 'node:path' {
  export const posix: {
    normalize(p: string): string;
    join(...parts: string[]): string;
    dirname(p: string): string;
  };
}
