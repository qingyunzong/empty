// Minimal ambient declarations for the Node.js built-ins used by this
// project. The environment has no @types/node and installs are offline,
// so we declare exactly what we touch — nothing more.

declare module 'node:test' {
  export interface TestContext {
    diagnostic(message: string): void;
  }
  export type TestFn = (t: TestContext) => void | Promise<void>;
  export function test(name: string, fn: TestFn): void;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: TestFn): void;
}

declare module 'node:assert/strict' {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): asserts value;
  export function fail(message?: string): never;
  export function rejects(
    promise: Promise<unknown>,
    matcher?:
      | RegExp
      | { new (...args: never[]): unknown }
      | Record<string, unknown>
      | ((err: unknown) => boolean),
    message?: string,
  ): Promise<void>;
}

declare function setTimeout(callback: () => void, ms: number): unknown;
declare function clearTimeout(handle: unknown): void;

declare const console: {
  log(...args: unknown[]): void;
};

declare class AbortController {
  readonly signal: AbortSignal;
  abort(reason?: unknown): void;
}

interface AbortSignal {
  readonly aborted: boolean;
  readonly reason?: unknown;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}
