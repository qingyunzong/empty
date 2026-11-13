declare module "node:assert/strict" {
  interface Assert {
    ok(value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    strictEqual(
      actual: unknown,
      expected: unknown,
      message?: string,
    ): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    notStrictEqual(
      actual: unknown,
      expected: unknown,
      message?: string,
    ): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    notDeepEqual(
      actual: unknown,
      expected: unknown,
      message?: string,
    ): void;
    rejects(
      fn: () => unknown,
      expected?: unknown,
      message?: string,
    ): Promise<void>;
    throws(fn: () => unknown, expected?: unknown, message?: string): void;
    doesNotThrow(
      fn: () => unknown,
      expected?: unknown,
      message?: string,
    ): void;
    match(value: string, pattern: RegExp, message?: string): void;
    doesNotMatch(value: string, pattern: RegExp, message?: string): void;
    fail(message?: string): never;
    ifError(value: unknown): void;
  }
  const assert: Assert;
  export default assert;
}

declare module "node:assert" {
  interface Assert {
    ok(value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    strictEqual(
      actual: unknown,
      expected: unknown,
      message?: string,
    ): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    notStrictEqual(
      actual: unknown,
      expected: unknown,
      message?: string,
    ): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    notDeepEqual(
      actual: unknown,
      expected: unknown,
      message?: string,
    ): void;
    rejects(
      fn: () => unknown,
      expected?: unknown,
      message?: string,
    ): Promise<void>;
    throws(fn: () => unknown, expected?: unknown, message?: string): void;
    doesNotThrow(
      fn: () => unknown,
      expected?: unknown,
      message?: string,
    ): void;
    match(value: string, pattern: RegExp, message?: string): void;
    doesNotMatch(value: string, pattern: RegExp, message?: string): void;
    fail(message?: string): never;
    ifError(value: unknown): void;
  }
  const assert: Assert;
  export default assert;
  export { assert };
  export const strict: Assert;
}

declare module "node:test" {
  export function describe(
    name: string,
    fn: () => void | Promise<void>,
  ): void;
  export function test(
    name: string,
    fn: () => void | Promise<void>,
  ): void;
  export const it: typeof test;
  export function before(fn: () => void | Promise<void>): void;
  export function after(fn: () => void | Promise<void>): void;
  export function beforeEach(fn: () => void | Promise<void>): void;
  export function afterEach(fn: () => void | Promise<void>): void;
  export const mock: any;
}

declare module "node:events" {
  export class EventEmitter {
    on(event: string, listener: (...args: unknown[]) => void): this;
    off(event: string, listener: (...args: unknown[]) => void): this;
    emit(event: string, ...args: unknown[]): boolean;
  }
}

declare module "node:util" {
  export function inspect(value: unknown): string;
}

declare module "node:crypto" {
  export function randomUUID(): string;
  export function randomBytes(size: number): Uint8Array;
}

declare module "node:timers/promises" {
  export function setTimeout(
    delay?: number,
    value?: unknown,
  ): Promise<unknown>;
}

declare module "node:fs";
declare module "node:fs/promises";
declare module "node:path";
declare module "node:os";
