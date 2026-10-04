// Minimal ambient declarations for the Node.js built-ins used here, so that
// `tsc --noEmit` works without installing @types/node (offline environment).
declare module "node:buffer" {
  export class Buffer extends Uint8Array {
    static from(data: string, encoding?: string): Buffer;
    static from(data: number[]): Buffer;
    static concat(list: Uint8Array[]): Buffer;
    toString(encoding?: string): string;
    subarray(start?: number, end?: number): Buffer;
  }
}

declare module "node:test" {
  export default function test(
    name: string,
    fn: () => void | Promise<void>,
  ): void;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepStrictEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  const assert: {
    equal: typeof equal;
    deepEqual: typeof deepEqual;
    deepStrictEqual: typeof deepStrictEqual;
    ok: typeof ok;
  };
  export default assert;
}
