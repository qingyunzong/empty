declare module 'node:assert/strict' {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function throws(fn: () => unknown, expected?: RegExp | (new (...args: never[]) => Error), message?: string): void;
}

declare module 'node:test' {
  export function test(name: string, fn: () => void | Promise<void>): void;
}
