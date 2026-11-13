// Minimal ambient declarations for the Node builtins used in tests.
// (@types/node is not installed in this offline environment.)
declare module "node:assert/strict" {
  const assert: {
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
  };
  export default assert;
}

declare module "node:test" {
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => void): void;
}
