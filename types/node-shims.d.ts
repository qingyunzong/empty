// Minimal ambient declarations for the Node.js built-ins used here.
// The environment has no @types/node and no network access, so only the
// small surface this project needs is declared.
declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module "node:assert/strict" {
  export function strictEqual(actual: unknown, expected: unknown): void;
  export function notStrictEqual(actual: unknown, expected: unknown): void;
  export function deepStrictEqual(actual: unknown, expected: unknown): void;
  export function throws(fn: () => unknown, error?: unknown): void;
  export function rejects(
    promise: Promise<unknown>,
    error?: unknown,
  ): Promise<void>;
  const assert: {
    strictEqual: typeof strictEqual;
    notStrictEqual: typeof notStrictEqual;
    deepStrictEqual: typeof deepStrictEqual;
    throws: typeof throws;
    rejects: typeof rejects;
  };
  export default assert;
}

declare function setImmediate(callback: () => void): void;
