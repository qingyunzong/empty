/**
 * Minimal offline type declarations for the Node.js built-in modules and
 * globals used by this project. The environment has no network access, so
 * `@types/node` cannot be installed; these cover exactly what we use.
 */

declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
}

declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepStrictEqual(
    actual: unknown,
    expected: unknown,
    message?: string,
  ): void;
  export function throws(fn: () => unknown, pattern?: RegExp, message?: string): void;
  const assert: {
    equal: typeof equal;
    deepStrictEqual: typeof deepStrictEqual;
    throws: typeof throws;
  };
  export default assert;
}

declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

declare const process: {
  argv: string[];
  exit(code?: number): never;
};
