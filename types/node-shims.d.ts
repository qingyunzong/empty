// Minimal type declarations for the Node.js built-in modules used by this
// project. The project has zero npm dependencies (Node built-ins only), so
// @types/node is not installed; these shims cover exactly what we use.

declare module 'node:test' {
  export type TestFn = () => void | Promise<void>;
  export default function test(name: string, fn: TestFn): void;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: TestFn): void;
}

declare module 'node:assert/strict' {
  export function ok(value: unknown, message?: string): asserts value;
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function throws(fn: () => unknown, expected?: RegExp | ((err: unknown) => boolean), message?: string): void;
  export function match(actual: string, expected: RegExp, message?: string): void;
}

declare var console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};
