// Minimal ambient declarations for the Node.js built-in modules used here,
// so the project compiles without @types/node (no external dependencies).
declare function structuredClone<T>(value: T): T;

declare module "node:assert" {
  export function ok(value: unknown, message?: string): void;
  export function fail(message?: string): never;
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function match(value: string, pattern: RegExp, message?: string): void;
  export function throws(fn: () => unknown, check?: unknown, message?: string): void;
  const assert: {
    ok: typeof ok;
    fail: typeof fail;
    equal: typeof equal;
    notEqual: typeof notEqual;
    deepEqual: typeof deepEqual;
    match: typeof match;
    throws: typeof throws;
  };
  export default assert;
}

declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => void | Promise<void>): void;
  export default test;
}
