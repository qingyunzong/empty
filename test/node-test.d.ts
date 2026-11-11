// Minimal ambient declarations for the node:test / node:assert APIs used by
// the tests, since @types/node is not installed in this environment.
declare module "node:test" {
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => void): void;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  const assert: {
    equal: typeof equal;
    notEqual: typeof notEqual;
  };
  export default assert;
}
