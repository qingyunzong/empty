declare module 'node:test' {
  export type TestFn = () => void | Promise<void>;
  export default function test(name: string, fn: TestFn): void;
}

declare module 'node:assert/strict' {
  export function ok(value: unknown, message?: string): void;
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepStrictEqual(actual: unknown, expected: unknown, message?: string): void;
  export function notDeepStrictEqual(actual: unknown, expected: unknown, message?: string): void;
}

declare const console: {
  log(...args: unknown[]): void;
};
