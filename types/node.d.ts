// Minimal ambient declarations for the Node.js built-ins used by this
// project. The offline environment has no @types/node, so only the exact
// APIs we rely on are declared here.

declare class Buffer extends Uint8Array {
  static from(data: string, encoding?: string): Buffer;
  static from(data: readonly number[]): Buffer;
  static from(data: Uint8Array): Buffer;
  static concat(list: readonly Uint8Array[]): Buffer;
  static alloc(size: number, fill?: number): Buffer;
  static isBuffer(value: unknown): value is Buffer;
  equals(other: Uint8Array): boolean;
  toString(encoding?: string): string;
}

declare module "node:crypto" {
  interface Hash {
    update(data: Uint8Array): Hash;
    digest(): Buffer;
  }
  export function createHash(algorithm: string): Hash;
}

declare module "node:test" {
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => void): void;
  export function test(name: string, fn: () => void): void;
}

declare module "node:assert/strict" {
  export function ok(value: unknown, message?: string): void;
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function throws(fn: () => void, message?: string): void;
}
