declare module "node:test" {
  export interface TestContext {
    name: string;
  }
  export function test(name: string, fn: (t: TestContext) => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
  export default test;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function throws(fn: () => unknown, matcher?: (err: unknown) => boolean, message?: string): void;
  export function match(actual: string, regexp: RegExp, message?: string): void;
}
