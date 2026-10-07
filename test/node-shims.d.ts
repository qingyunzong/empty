// Minimal ambient declarations for the Node built-ins used by the tests,
// so the suite compiles without downloading @types/node.
declare module 'node:assert/strict' {
  export function ok(value: unknown, message?: string): asserts value;
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function throws(fn: () => unknown, pattern?: RegExp, message?: string): void;
  export function match(value: string, pattern: RegExp, message?: string): void;
}

declare module 'node:test' {
  export default function test(name: string, fn: () => void | Promise<void>): void;
}
