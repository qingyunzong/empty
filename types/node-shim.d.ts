declare function setTimeout(
  callback: () => void,
  ms?: number,
): unknown;

declare module "node:test" {
  export type TestFn = () => void | Promise<void>;
  export function test(name: string, fn: TestFn): void;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: TestFn): void;
}

declare module "node:assert/strict" {
  type ThrowsExpected =
    | RegExp
    | ((err: unknown) => boolean)
    | (new (...args: never[]) => Error);
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): asserts value;
  export function throws(fn: () => unknown, expected?: ThrowsExpected, message?: string): void;
  export function rejects(fn: () => Promise<unknown>, expected?: ThrowsExpected, message?: string): Promise<void>;
  export function fail(message?: string): never;
}
