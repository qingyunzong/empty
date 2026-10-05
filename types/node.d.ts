/** Minimal offline declarations for the Node built-ins we use
 *  (no @types/node available in this environment). */

declare module "node:test" {
  export interface TestContext {
    diagnostic(message: string): void;
  }
  export function test(name: string, fn: (t: TestContext) => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
}

declare module "node:assert/strict" {
  export function ok(value: unknown, message?: string): void;
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function throws(fn: () => unknown, error?: unknown, message?: string): void;
  export function doesNotThrow(fn: () => unknown, message?: string): void;
  const assert: {
    ok: typeof ok;
    equal: typeof equal;
    notEqual: typeof notEqual;
    deepEqual: typeof deepEqual;
    throws: typeof throws;
    doesNotThrow: typeof doesNotThrow;
  };
  export default assert;
}
