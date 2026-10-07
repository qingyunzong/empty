declare module "node:buffer" {
  export class Buffer {
    static from(data: string, encoding?: string): Buffer;
    static compare(buf1: Buffer, buf2: Buffer): number;
  }
}

declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): unknown;
  export function describe(name: string, fn: () => void): unknown;
  export function it(name: string, fn: () => void | Promise<void>): unknown;
}

declare module "node:assert/strict" {
  interface Assert {
    (value: unknown, message?: string): asserts value;
    ok(value: unknown, message?: string): void;
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    notDeepEqual(actual: unknown, expected: unknown, message?: string): void;
    match(actual: string, regexp: RegExp, message?: string): void;
    throws(
      fn: () => unknown,
      error?: RegExp | ((err: unknown) => boolean) | { message?: string | RegExp },
      message?: string
    ): void;
  }
  const assert: Assert;
  export default assert;
}
