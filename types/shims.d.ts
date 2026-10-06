// Minimal ambient declarations: this Node build ships without @types/node
// and the sandbox has no network access to install it.

declare function queueMicrotask(callback: () => void): void;

declare module 'node:test' {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function test(name: string, options: unknown, fn: () => void | Promise<void>): void;
}

declare module 'node:assert/strict' {
  interface Assert {
    (value: unknown, message?: string): void;
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    match(value: string, regExp: RegExp, message?: string): void;
    throws(fn: () => void, message?: string): void;
  }
  const assert: Assert;
  export default assert;
}
