// Minimal ambient declarations for the Node.js built-in modules used by this
// library. The project has zero external dependencies, so @types/node is not
// available; only the exact APIs we consume are declared here.

declare module "node:crypto" {
  export interface Hash {
    update(data: string | Uint8Array, encoding?: string): Hash;
    digest(encoding: "hex"): string;
  }
  export function createHash(algorithm: string): Hash;
  export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
  export function randomInt(min: number, max: number): number;
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
  export function match(actual: string, expected: RegExp, message?: string): void;
  export function throws(fn: () => void, expected?: RegExp | (new (...args: never[]) => Error), message?: string): void;
}

declare function structuredClone<T>(value: T): T;
