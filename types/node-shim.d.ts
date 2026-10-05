// Minimal ambient typings for the Node.js built-in modules used by the tests.
// The environment has no registry access, so these stand in for @types/node.
declare module "node:test" {
  export type TestFn = () => void | Promise<void>;
  export default function test(name: string, fn: TestFn): void;
}

declare module "node:assert/strict" {
  export interface Assert {
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    rejects(promise: Promise<unknown>, pattern?: RegExp): Promise<void>;
  }
  const assert: Assert;
  export default assert;
}
