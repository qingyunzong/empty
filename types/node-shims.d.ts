declare module "node:test" {
  function test(name: string, fn: () => void | Promise<void>): void;
  export default test;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function throws(
    fn: () => void,
    expected?: RegExp | (new (...args: never[]) => Error) | ((error: unknown) => boolean),
    message?: string,
  ): void;
  export function fail(message?: string): never;
}

declare const process: {
  env: Record<string, string | undefined>;
};
