// Minimal ambient declarations for the Node.js built-ins we use, so the
// project compiles with zero external dependencies (no @types/node).
declare module 'node:test' {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => void | Promise<void>): void;
}

declare module 'node:assert/strict' {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): asserts value;
  export function throws(fn: () => void, error?: RegExp | (new (...args: never[]) => Error), message?: string): void;
  export function match(value: string, regExp: RegExp, message?: string): void;
  const assert: {
    equal: typeof equal;
    notEqual: typeof notEqual;
    deepEqual: typeof deepEqual;
    ok: typeof ok;
    throws: typeof throws;
    match: typeof match;
  };
  export default assert;
}

declare class Buffer extends Uint8Array {
  static from(data: string, encoding?: string): Buffer;
  static compare(a: Uint8Array, b: Uint8Array): number;
  equals(other: Uint8Array): boolean;
  toString(encoding?: string): string;
}
