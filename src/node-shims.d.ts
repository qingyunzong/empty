declare module "node:assert/strict" {
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  const assert: {
    deepEqual: typeof deepEqual;
    equal: typeof equal;
  };
  export default assert;
}

declare module "node:test" {
  export type TestFn = () => void | Promise<void>;
  export default function test(name: string, fn: TestFn): void;
}
