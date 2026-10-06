// Minimal Node.js declarations for offline builds (only what this project uses).
declare module "node:fs" {
  export function readFileSync(path: string | number, encoding: "utf8"): string;
}
declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
}
declare module "node:assert/strict" {
  const assert: {
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    throws(fn: () => void, pattern?: RegExp, message?: string): void;
  };
  export default assert;
}
declare const process: {
  argv: string[];
  execPath: string;
  stdout: { write(s: string): void };
  stderr: { write(s: string): void };
  exit(code?: number): never;
};
declare const require: { main: unknown };
declare const module: unknown;
