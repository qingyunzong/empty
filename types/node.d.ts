// Minimal ambient declarations for the Node.js built-in modules used by this
// project. The environment has no @types/node and no network access, so only
// the small surface we actually rely on is declared here.

declare module "node:test" {
  export type TestFn = () => void | Promise<void>;
  export function test(name: string, fn: TestFn): void;
  export function describe(name: string, fn: () => void): void;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): asserts value;
  export function throws(fn: () => unknown, message?: string): void;
  export function rejects(promise: Promise<unknown> | (() => Promise<unknown>), pattern?: RegExp | string): Promise<void>;
}

declare module "node:crypto" {
  export function createHash(algorithm: string): {
    update(data: string | Uint8Array): void;
    digest(encoding: "hex"): string;
  };
}

declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function existsSync(path: string): boolean;
}

declare module "node:util" {
  export function isDeepStrictEqual(a: unknown, b: unknown): boolean;
}
