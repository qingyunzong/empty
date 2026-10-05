// Minimal ambient declarations for the Node.js built-ins used by this
// package. The sandbox has no network access, so @types/node cannot be
// installed; these cover exactly the APIs we touch.

declare class Buffer extends Uint8Array {
  static from(data: string, encoding: 'utf8'): Buffer;
  static from(data: Uint8Array): Buffer;
  static concat(list: readonly Uint8Array[]): Buffer;
  static alloc(size: number): Buffer;
  compare(other: Uint8Array): number;
  equals(other: Uint8Array): boolean;
  toString(encoding?: 'utf8' | 'hex'): string;
}

declare module 'node:crypto' {
  export interface Hash {
    update(data: Uint8Array): Hash;
    digest(encoding: 'hex'): string;
  }
  export function createHash(algorithm: string): Hash;
}

declare module 'node:test' {
  export type TestFn = () => void | Promise<void>;
  export function test(name: string, fn: TestFn): void;
  export function describe(name: string, fn: () => void): void;
  export default test;
}

declare module 'node:assert/strict' {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): asserts value;
  export function throws(fn: () => void, error?: RegExp | ((err: unknown) => boolean) | (new (...args: any[]) => any), message?: string): void;
  export function match(actual: string, regexp: RegExp, message?: string): void;
}

declare class TextEncoder {
  encode(input?: string): Uint8Array;
}

declare class TextDecoder {
  constructor(label?: string, options?: { fatal?: boolean });
  decode(input?: Uint8Array): string;
}
