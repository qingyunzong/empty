// Minimal ambient declarations for the Node.js built-in modules used here.
// The project intentionally has no external dependencies (no @types/node).

declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function test(fn: () => void | Promise<void>): void;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): asserts value;
  export function throws(fn: () => unknown, matcher?: RegExp | ((err: unknown) => boolean), message?: string): void;
  const assert: {
    equal: typeof equal;
    deepEqual: typeof deepEqual;
    ok: typeof ok;
    throws: typeof throws;
  };
  export default assert;
}

declare const process: {
  exitCode?: number;
  argv: string[];
};

declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};
