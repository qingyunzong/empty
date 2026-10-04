// Minimal ambient declarations for the Node.js built-ins used by this
// package. The environment has no @types/node installed; runtime behavior
// relies solely on Node.js built-in modules and globals.

declare function setTimeout(callback: () => void, ms: number): unknown;
declare function clearTimeout(handle: unknown): void;
declare function structuredClone<T>(value: T): T;

declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module "node:assert/strict" {
  const assert: {
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    fail(message?: string): never;
  };
  export default assert;
}
