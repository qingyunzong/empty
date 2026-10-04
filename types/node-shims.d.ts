// Minimal ambient declarations for the Node.js built-ins used by the tests.
// The sandbox has no network access, so @types/node cannot be installed.

declare module 'node:test' {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module 'node:assert/strict' {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): asserts value;
  export function throws(fn: () => unknown, error?: unknown, message?: string): void;
  export function rejects(
    promise: Promise<unknown>,
    error?: unknown,
    message?: string,
  ): Promise<void>;
  const assert: {
    equal: typeof equal;
    ok: typeof ok;
    throws: typeof throws;
    rejects: typeof rejects;
  };
  export default assert;
}

declare function setImmediate(callback: (...args: unknown[]) => void): unknown;
