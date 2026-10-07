declare module "node:buffer" {
  export const Buffer: {
    from(data: Uint8Array): { toString(encoding: "base64" | "hex"): string };
    from(data: string, encoding: "base64"): Uint8Array;
  };
}

declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => void | Promise<void>): void;
}

declare module "node:assert/strict" {
  const assert: {
    (value: unknown, message?: string): void;
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    notDeepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    throws(
      fn: () => unknown,
      expected?: RegExp | ((err: unknown) => boolean) | (new (...args: never[]) => unknown),
      message?: string
    ): void;
  };
  export default assert;
}
