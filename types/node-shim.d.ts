// Minimal Node.js type declarations for offline type-checking (no @types/node).
declare class Buffer extends Uint8Array {
  static from(data: string, encoding?: string): Buffer;
  static from(data: Uint8Array): Buffer;
  static concat(list: readonly Uint8Array[]): Buffer;
  static alloc(size: number): Buffer;
  toString(encoding?: string): string;
  equals(other: Uint8Array): boolean;
}

declare module 'node:test' {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module 'node:assert/strict' {
  interface Assert {
    (value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): asserts value;
    match(actual: string, regexp: RegExp, message?: string): void;
  }
  const assert: Assert;
  export default assert;
}
