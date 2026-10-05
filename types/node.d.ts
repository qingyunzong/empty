// Minimal type declarations for the Node.js built-ins used by this project.
// The environment has no @types/node package; these cover exactly the APIs
// exercised by src/ and test/.

interface Buffer extends Uint8Array {
  equals(other: Uint8Array): boolean;
}

declare const Buffer: {
  from(data: Uint8Array | readonly number[] | string): Buffer;
};

declare module "node:crypto" {
  interface Hash {
    update(data: Uint8Array | string): Hash;
    digest(): Buffer;
  }
  export function createHash(algorithm: string): Hash;
  export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
  export function randomBytes(size: number): Buffer;
}

declare module "node:test" {
  export default function test(name: string, fn: () => void | Promise<void>): void;
}

declare module "node:assert/strict" {
  interface Assert {
    (value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
  }
  const assert: Assert;
  export default assert;
}
