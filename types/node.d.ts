// Minimal ambient declarations for the Node.js built-ins used by this
// project. The environment has no @types/node and no network access, so we
// declare exactly the surface we rely on (all Node.js built-ins).

declare class Buffer extends Uint8Array {
  static from(data: string, encoding?: string): Buffer;
  static from(data: Uint8Array): Buffer;
  static concat(list: Uint8Array[]): Buffer;
  static byteLength(text: string, encoding?: string): number;
  toString(encoding?: string): string;
  subarray(start?: number, end?: number): Buffer;
  slice(start?: number, end?: number): Buffer;
}

declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
}
