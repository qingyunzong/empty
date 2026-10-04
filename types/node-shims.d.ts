declare module "node:crypto" {
  export interface Hash {
    update(data: string): Hash;
    digest(encoding: "hex"): string;
  }
  export function createHash(algorithm: string): Hash;
}

declare module "node:test" {
  export type TestFn = () => void | Promise<void>;
  export function test(name: string, fn: TestFn): void;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: TestFn): void;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function match(value: string, pattern: RegExp, message?: string): void;
  export function throws(fn: () => void, match?: RegExp | ((err: unknown) => boolean), message?: string): void;
  export function fail(message?: string): never;
}

declare module "node:process" {
  const process: {
    argv: string[];
    exitCode?: number;
  };
  export default process;
}

declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};
