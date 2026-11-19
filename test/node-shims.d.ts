declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => void | Promise<void>): void;
}

declare module "node:assert/strict" {
  interface AssertStrict {
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    throws(fn: () => unknown, matcher?: RegExp | { name?: string; message?: RegExp }): void;
  }
  const assert: AssertStrict;
  export default assert;
}

declare module "node:fs" {
  export function readFileSync(path: string | URL, encoding: "utf8"): string;
}

declare module "node:url" {
  export function fileURLToPath(url: URL | string): string;
}
