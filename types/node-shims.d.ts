// Minimal ambient declarations for the Node built-ins used by the tests.
// The offline environment has no @types/node; keep in sync with usage.

declare module 'node:assert/strict' {
  export function ok(value: unknown, message?: string): asserts value;
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function throws(fn: () => unknown, error?: unknown, message?: string): void;
  export function rejects(
    promise: Promise<unknown> | (() => Promise<unknown>),
    error?: unknown,
    message?: string,
  ): Promise<void>;
  const assert: {
    ok: typeof ok;
    equal: typeof equal;
    deepEqual: typeof deepEqual;
    throws: typeof throws;
    rejects: typeof rejects;
  };
  export default assert;
}

declare module 'node:test' {
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => void | Promise<void>): void;
}
