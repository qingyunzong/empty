// Minimal ambient declarations for the Node.js built-ins used by this project.
// The runtime relies only on Node.js built-in modules; these declarations exist
// because @types/node is not installed (offline environment).

declare var process: {
  argv: string[];
  execPath: string;
  cwd(): string;
  exitCode: number | undefined;
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
};

declare class URL {
  constructor(url: string);
  protocol: string;
  hostname: string;
  port: string;
}

declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function writeFileSync(path: string, data: string): void;
  export function mkdtempSync(prefix: string): string;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
}

declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function throws(fn: () => void, error?: RegExp, message?: string): void;
}
