// Minimal typings for the Node built-ins used by the tests. The sandbox has
// no network access, so @types/node cannot be installed.
declare module "node:test" {
  type TestFn = () => void | Promise<void>;
  export function test(name: string, fn: TestFn): void;
  export function describe(name: string, fn: () => void): void;
  const _default: typeof test;
  export default _default;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): asserts value;
  export function fail(message?: string): never;
  export function rejects(
    promise: Promise<unknown>,
    validator?: (error: unknown) => boolean,
    message?: string
  ): Promise<void>;
}
