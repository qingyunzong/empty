// Minimal ambient declarations for the Node.js built-in APIs used by this
// project. The environment has no @types/node and no network access, so we
// declare exactly the surface we rely on.
// NOTE: this file intentionally has no top-level import/export so that every
// declaration below is global.

interface Buffer extends Uint8Array<ArrayBuffer> {
  toString(encoding?: "utf8" | "utf-8" | "latin1" | "hex"): string;
  slice(start?: number, end?: number): Buffer;
  subarray(start?: number, end?: number): Buffer;
}

declare var Buffer: {
  from(data: string, encoding?: "utf8" | "utf-8" | "latin1" | "hex"): Buffer;
  from(data: Uint8Array | number[]): Buffer;
  concat(list: Uint8Array[]): Buffer;
  isBuffer(value: unknown): value is Buffer;
};

declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function throws(fn: () => void, message?: string): void;
}
