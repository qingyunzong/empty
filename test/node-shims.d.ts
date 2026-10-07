// Minimal ambient declarations for the Node built-ins used by the tests.
// (No network access to install @types/node in this environment.)
declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function throws(fn: () => unknown, error?: unknown, message?: string): void;
  const assert: {
    equal: typeof equal;
    deepEqual: typeof deepEqual;
    throws: typeof throws;
  };
  export default assert;
}
