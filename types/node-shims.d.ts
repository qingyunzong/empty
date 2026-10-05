// Minimal ambient declarations for the Node.js built-ins used by this
// project, so `tsc` can type-check without @types/node (offline-friendly).

declare module 'node:path' {
  export const posix: {
    normalize(path: string): string;
    join(...paths: string[]): string;
    dirname(path: string): string;
  };
}

declare module 'node:assert/strict' {
  const assert: {
    ok(value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    match(actual: string, regexp: RegExp, message?: string): void;
    fail(message?: string): never;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    throws(fn: () => unknown, error?: unknown): any;
  };
  export default assert;
}

declare module 'node:test' {
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => void): void;
}

declare function structuredClone<T>(value: T): T;
