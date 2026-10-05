// Minimal ambient declarations for the Node.js built-in modules used by
// the tests. The environment has no registry access, so @types/node
// cannot be installed; only the used surface is declared here.
declare module "node:test" {
  export type TestFn = () => void | Promise<void>;
  export default function test(name: string, fn: TestFn): void;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: TestFn): void;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): asserts value;
  export function throws(fn: () => unknown, message?: string): void;
}

declare const process: { argv: string[] };
declare const console: { log(...args: unknown[]): void };
