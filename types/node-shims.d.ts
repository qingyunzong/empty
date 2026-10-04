declare function structuredClone<T>(value: T): T;
declare const console: { log(...args: unknown[]): void };

declare module "node:crypto" {
  export interface Hash {
    update(data: string): Hash;
    digest(encoding: "hex"): string;
  }
  export function createHash(algorithm: string): Hash;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): asserts value;
  const assert: {
    equal: typeof equal;
    notEqual: typeof notEqual;
    deepEqual: typeof deepEqual;
    ok: typeof ok;
  };
  export default assert;
}

declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export default test;
}
