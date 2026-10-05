// Minimal offline type declarations for the Node.js built-ins used by this
// project. The sandbox has no network access, so @types/node cannot be
// installed; these cover exactly the APIs in use.

declare class Buffer extends Uint8Array {
  static alloc(size: number, fill?: number): Buffer;
  static concat(list: Uint8Array[]): Buffer;
  static from(data: Uint8Array | number[]): Buffer;
  subarray(start?: number, end?: number): Buffer;
  equals(other: Uint8Array): boolean;
  writeUInt16LE(value: number, offset: number): number;
  writeUInt32LE(value: number, offset: number): number;
  writeBigUInt64LE(value: bigint, offset: number): number;
  readUInt16LE(offset: number): number;
  readUInt32LE(offset: number): number;
  readBigUInt64LE(offset: number): bigint;
}

declare module "node:zlib" {
  export function deflateRawSync(input: Uint8Array, options?: { level?: number }): Buffer;
  export function inflateRawSync(input: Uint8Array): Buffer;
  export function crc32(data: Uint8Array): number;
}

declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module "node:assert/strict" {
  export function ok(value: unknown, message?: string): void;
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function throws(
    fn: () => void,
    expected?: (new (...args: never[]) => Error) | RegExp | ((err: unknown) => boolean),
    message?: string,
  ): void;
  export function fail(message?: string): never;
}
