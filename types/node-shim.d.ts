// Minimal ambient declarations for the Node.js built-in modules used by the
// tests. The environment is offline, so @types/node cannot be installed;
// only the surface actually used is declared here.
declare module 'node:test' {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module 'node:assert/strict' {
  export function ok(value: unknown, message?: string): void;
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function match(actual: string, regexp: RegExp, message?: string): void;
  export function throws(
    fn: () => unknown,
    expected?: RegExp | Error | (new (...args: never[]) => unknown) | ((e: unknown) => boolean),
    message?: string,
  ): void;
  export function fail(message?: string): never;
  const assert: {
    ok: typeof ok;
    equal: typeof equal;
    deepEqual: typeof deepEqual;
    match: typeof match;
    throws: typeof throws;
    fail: typeof fail;
  };
  export default assert;
}
