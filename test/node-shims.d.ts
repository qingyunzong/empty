declare module "node:test" {
  type TestFn = () => void | Promise<void>;
  export function test(name: string, fn: TestFn): void;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: TestFn): void;
  export default test;
}

declare module "node:assert/strict" {
  type Expected = RegExp | (new (...args: never[]) => unknown) | ((err: unknown) => boolean);
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): asserts value;
  export function fail(message?: string): never;
  export function throws(fn: () => unknown, expected?: Expected, message?: string): void;
  export function rejects(fn: () => Promise<unknown>, expected?: Expected, message?: string): Promise<void>;
  export function match(actual: string, expected: RegExp, message?: string): void;
}
