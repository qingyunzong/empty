// Minimal ambient typings for the Node.js built-in modules used by this
// project. The offline environment has no @types/node, so only the small
// surface we actually consume is declared here.
declare module "node:test" {
  export interface TestContext {
    readonly name: string;
    test(name: string, fn: (t: TestContext) => void | Promise<void>): Promise<void>;
  }
  export function test(name: string, fn: (t: TestContext) => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: (t: TestContext) => void | Promise<void>): void;
  export default test;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): asserts value;
  export function fail(message?: string): never;
  export function rejects(
    block: (() => Promise<unknown>) | Promise<unknown>,
    error?: RegExp | (new (...args: never[]) => Error) | ((err: unknown) => boolean),
    message?: string,
  ): Promise<void>;
  export function throws(
    block: () => unknown,
    error?: RegExp | (new (...args: never[]) => Error) | ((err: unknown) => boolean),
    message?: string,
  ): void;
}

declare function setTimeout(callback: (...args: never[]) => void, ms?: number): unknown;
