// Minimal ambient declarations for the Node.js built-in modules used by
// this package. The project has zero npm dependencies, so these cover only
// the APIs actually consumed (node:crypto, node:assert/strict, node:test).

declare module "node:crypto" {
  export interface Hash {
    update(data: string, inputEncoding?: string): Hash;
    digest(encoding: "hex"): string;
  }
  export function createHash(algorithm: string): Hash;
}

declare module "node:assert/strict" {
  interface AssertStrict {
    (value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    match(actual: string, regexp: RegExp, message?: string): void;
    throws(fn: () => unknown, expected?: unknown, message?: string): void;
  }
  const assert: AssertStrict;
  export default assert;
}

declare module "node:test" {
  export type TestFn = () => void | Promise<void>;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: TestFn): void;
}
