declare module 'node:crypto' {
  export interface Hash {
    update(data: string | Uint8Array): Hash;
    digest(): { toString(encoding: 'hex' | 'base64url'): string };
  }
  export function createHash(algorithm: 'sha256'): Hash;
}

declare class TextEncoder {
  encode(input?: string): Uint8Array;
}

declare class TextDecoder {
  decode(input?: Uint8Array): string;
}

declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

declare const Buffer: {
  from(data: string, encoding: 'utf8' | 'base64url'): {
    toString(encoding: 'utf8' | 'base64url'): string;
  };
};

declare module 'node:test' {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module 'node:assert/strict' {
  function assert(value: unknown, message?: string): asserts value;
  namespace assert {
    function equal(actual: unknown, expected: unknown, message?: string): void;
    function deepEqual(actual: unknown, expected: unknown, message?: string): void;
    function notEqual(actual: unknown, expected: unknown, message?: string): void;
    function ok(value: unknown, message?: string): void;
    function notDeepEqual(actual: unknown, expected: unknown, message?: string): void;
    function throws(fn: () => unknown, error?: unknown): void;
    function rejects(fn: () => Promise<unknown>, error?: unknown): Promise<void>;
  }
  export default assert;
}
