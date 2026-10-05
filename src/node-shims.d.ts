// Minimal ambient declarations for the Node.js built-in modules used by
// this project. The environment is offline, so @types/node is unavailable.
declare module "node:fs" {
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function openSync(path: string, flags: string): number;
  export function readFileSync(path: string, encoding: string): string;
  export function renameSync(from: string, to: string): void;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  export function writeFileSync(path: string, data: string, encoding?: string): void;
  export function fsyncSync(fd: number): void;
  export function closeSync(fd: number): void;
  export function mkdtempSync(prefix: string): string;
}
declare module "node:path" {
  export function join(...parts: string[]): string;
}
declare module "node:os" {
  export function tmpdir(): string;
}
declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
}
declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function throws(fn: () => void, expected?: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  const assert: {
    equal: typeof equal;
    deepEqual: typeof deepEqual;
    throws: typeof throws;
    ok: typeof ok;
  };
  export default assert;
}
