declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => void | Promise<void>): void;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function match(actual: string, regexp: RegExp, message?: string): void;
  export function throws(fn: () => unknown, message?: string): void;
  export function rejects(promise: Promise<unknown>, message?: string): Promise<void>;
}

declare module "node:fs" {
  export function readFileSync(path: unknown, encoding: "utf8"): string;
  export function writeFileSync(path: unknown, data: string): void;
}

declare function setImmediate(callback: () => void): void;

declare const process: {
  argv: string[];
};
