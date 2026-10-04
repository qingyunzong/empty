// Minimal ambient declarations for the Node.js built-ins used by this project.
// (The sandbox has no network access to install @types/node.)
declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
}
declare module "node:assert/strict" {
  const assert: {
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    throws(fn: () => void, pattern?: RegExp): void;
  };
  export default assert;
}
declare module "node:crypto" {
  export function createHash(algorithm: string): {
    update(data: string): { digest(encoding: "hex"): string };
  };
}
declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function writeFileSync(path: string, data: string): void;
  export function existsSync(path: string): boolean;
  export function unlinkSync(path: string): void;
  export function mkdtempSync(prefix: string): string;
}
declare module "node:path" {
  export function join(...parts: string[]): string;
}
declare module "node:os" {
  export function tmpdir(): string;
}
declare const process: {
  argv: string[];
  exit(code: number): never;
  stdout: { write(s: string): void };
  stderr: { write(s: string): void };
};
