// Minimal ambient declarations for the Node.js built-ins used by this
// package. The environment has no network access, so @types/node cannot be
// installed; only the small surface we actually rely on is declared here.

interface Buffer extends Uint8Array {
  toString(encoding?: string): string;
  subarray(begin?: number, end?: number): Buffer;
}

declare const Buffer: {
  from(data: string, encoding?: string): Buffer;
  from(data: Uint8Array): Buffer;
  concat(list: Uint8Array[]): Buffer;
  alloc(size: number): Buffer;
};

declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module "node:assert/strict" {
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function throws(fn: () => unknown, expected?: RegExp): void;
  export function match(value: string, regexp: RegExp): void;
}
