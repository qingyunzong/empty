declare module "node:assert" {
  export function ok(value: unknown, message?: string): asserts value;
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function strictEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepStrictEqual(actual: unknown, expected: unknown, message?: string): void;
  export function throws(fn: () => void, error?: new (...args: any[]) => Error, message?: string): void;
  const assert: {
    ok: typeof ok;
    equal: typeof equal;
    deepEqual: typeof deepEqual;
    strictEqual: typeof strictEqual;
    deepStrictEqual: typeof deepStrictEqual;
    throws: typeof throws;
  };
  export default assert;
}

declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export default test;
}

declare module "node:crypto" {
  export interface Hash {
    update(data: string): Hash;
    digest(encoding: "hex"): string;
  }
  export function createHash(algorithm: string): Hash;
}
