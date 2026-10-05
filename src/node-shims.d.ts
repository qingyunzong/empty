// Minimal ambient declarations for the Node.js built-ins used by this
// project, so `tsc` type-checks without installing @types/node.

declare class Buffer extends Uint8Array {
  static from(data: readonly number[] | Uint8Array): Buffer;
  static from(text: string, encoding: "utf8" | "hex"): Buffer;
  static alloc(size: number): Buffer;
  static concat(chunks: readonly Uint8Array[]): Buffer;
  static byteLength(text: string): number;
  readUInt32BE(offset: number): number;
  writeUInt32BE(value: number, offset: number): number;
  toString(encoding?: "utf8" | "hex"): string;
  subarray(start?: number, end?: number): Buffer;
}

declare class TextEncoder {
  encode(input?: string): Uint8Array;
}

declare module "node:crypto" {
  interface Hash {
    update(data: Uint8Array): Hash;
    digest(): Buffer;
    digest(encoding: "hex"): string;
  }
  export function createHash(algorithm: string): Hash;
}

declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module "node:assert/strict" {
  interface Assert {
    (value: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    notDeepEqual(actual: unknown, expected: unknown, message?: string): void;
    match(value: string, pattern: RegExp, message?: string): void;
    throws(
      fn: () => unknown,
      check?: RegExp | ((err: unknown) => boolean) | (new (...args: never[]) => Error),
      message?: string,
    ): void;
  }
  const assert: Assert;
  export default assert;
}
