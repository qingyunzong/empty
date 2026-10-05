// Minimal Node.js type declarations (offline environment, no @types/node).
declare module "node:assert/strict" {
  const assert: {
    (value: unknown, message?: string): void;
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    throws(fn: () => unknown, error?: unknown, message?: string): void;
  };
  export default assert;
}
declare module "node:test" {
  export default function test(name: string, fn: () => void | Promise<void>): void;
}
declare module "node:fs" {
  export function readFileSync(path: string | number, encoding: string): string;
}
declare const process: {
  argv: string[];
  stdout: { write(chunk: string): void };
};
