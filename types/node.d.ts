// Minimal ambient declarations for the Node.js built-in modules used by
// this project. The environment has no registry access, so @types/node
// cannot be installed; only the actually-used surface is declared here.

declare module "node:crypto" {
  interface Hash {
    update(data: string, encoding: string): Hash;
    digest(encoding: "hex"): string;
  }
  export function createHash(algorithm: "sha256"): Hash;
}

declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module "node:assert/strict" {
  interface Assert {
    (value: unknown, message?: string): asserts value;
    ok(value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    throws(fn: () => void, pattern?: RegExp, message?: string): void;
  }
  const assert: Assert;
  export default assert;
}
