declare module "node:crypto" {
  export interface Hash {
    update(data: string, encoding?: "utf8"): Hash;
    digest(encoding: "hex" | "base64url"): string;
  }
  export function createHash(algorithm: string): Hash;
  export function randomUUID(): string;
}

declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function throws(
    fn: () => void,
    expected?: RegExp | (new (...args: never[]) => Error) | ((error: unknown) => boolean),
    message?: string
  ): void;
}

declare const Buffer: {
  from(data: string, encoding?: "utf8" | "base64url"): {
    toString(encoding: "utf8" | "base64url"): string;
  };
};
