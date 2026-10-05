// Minimal ambient declarations for the Node.js built-ins used by this
// package, so `npm run typecheck` works offline without @types/node.

declare module 'node:string_decoder' {
  export class StringDecoder {
    constructor(encoding?: string);
    write(buffer: Uint8Array): string;
    end(buffer?: Uint8Array): string;
  }
}

declare module 'node:assert' {
  interface Assert {
    (value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    strictEqual(actual: unknown, expected: unknown, message?: string): void;
    deepStrictEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): asserts value;
    match(actual: string, regexp: RegExp, message?: string): void;
  }
  const assert: Assert;
  export default assert;
}

declare module 'node:assert/strict' {
  import assert from 'node:assert';
  export default assert;
}

declare module 'node:test' {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
}

// Declared loosely: the real Buffer type ships with @types/node.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const Buffer: any;
