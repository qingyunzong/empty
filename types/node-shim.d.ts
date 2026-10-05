// Minimal ambient declarations for the Node.js built-ins used by this
// project, so the code compiles without @types/node (offline environment).
declare module "node:crypto" {
  export interface Hash {
    update(data: Uint8Array): Hash;
    digest(): Uint8Array;
  }
  export function createHash(algorithm: string): Hash;
}

declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function throws(fn: () => unknown, error?: unknown, message?: string): void;
}
