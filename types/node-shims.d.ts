// Minimal ambient declarations for the Node.js built-ins this project uses.
// The environment has no @types/node, and the project depends on Node
// built-in modules only, so we declare exactly what we touch.

declare class Buffer {
  static from(data: string, encoding?: string): Buffer;
  static byteLength(data: string, encoding?: string): number;
  static concat(list: Buffer[]): Buffer;
  subarray(start?: number, end?: number): Buffer;
  toString(encoding?: string): string;
  readonly length: number;
}

declare module "node:test" {
  type TestFn = () => void | Promise<void>;
  export function test(name: string, fn: TestFn): void;
  export function describe(name: string, fn: () => void): void;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function match(actual: string, regexp: RegExp, message?: string): void;
}
