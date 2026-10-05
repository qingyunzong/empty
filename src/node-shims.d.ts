/**
 * Minimal ambient declarations for the Node.js built-in modules and globals
 * used by this project. The library has zero runtime/dev dependencies, so
 * types/node is intentionally not required.
 */

declare module "node:crypto" {
  export interface Hash {
    update(data: string, encoding?: string): Hash;
    digest(encoding: "hex"): string;
  }
  export function createHash(algorithm: string): Hash;
}

declare module "node:test" {
  export interface TestContext {
    diagnostic(message: string): void;
  }
  export function test(
    name: string,
    fn: (t: TestContext) => void | Promise<void>,
  ): void;
  export function describe(name: string, fn: () => void): void;
  export function it(
    name: string,
    fn: (t: TestContext) => void | Promise<void>,
  ): void;
}

declare module "node:assert/strict" {
  export function ok(value: unknown, message?: string): asserts value;
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function strictEqual(actual: unknown, expected: unknown, message?: string): void;
  export function notStrictEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepStrictEqual(actual: unknown, expected: unknown, message?: string): void;
  export function match(actual: string, expected: RegExp, message?: string): void;
  export function throws(
    fn: () => unknown,
    expected?: RegExp | ((err: unknown) => boolean),
    message?: string,
  ): void;
  export function doesNotThrow(fn: () => unknown, message?: string): void;
}

declare class URL {
  constructor(url: string, base?: string);
  pathname: string;
  search: string;
  href: string;
}

declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};
