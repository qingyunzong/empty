// Minimal ambient declarations so the suite compiles without @types/node.
declare module 'node:test' {
  type TestFn = () => void | Promise<void>;
  export function test(name: string, fn: TestFn): void;
}

declare module 'node:assert/strict' {
  export function ok(value: unknown, message?: string): asserts value;
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function throws(fn: () => void, message?: string): void;
  export function rejects(promise: Promise<unknown>, message?: string): Promise<void>;
  export function fail(message?: string): never;
}
