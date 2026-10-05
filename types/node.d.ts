// Minimal ambient declarations for the Node.js built-in modules used by the
// tests. The project has no npm dependencies (offline environment), so these
// cover exactly the surface we use instead of @types/node.

declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): asserts value;
  export function throws(fn: () => unknown, expected?: unknown, message?: string): void;
  export function fail(message?: string): never;
  const assert: {
    equal: typeof equal;
    deepEqual: typeof deepEqual;
    ok: typeof ok;
    throws: typeof throws;
    fail: typeof fail;
  };
  export default assert;
}
