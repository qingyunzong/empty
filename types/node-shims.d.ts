// Minimal ambient declarations for the Node.js APIs used by this project.
// The sandbox has no @types/node and no network access, so we declare only
// the surface we actually consume.

declare module "node:stream" {
  export class Readable implements AsyncIterable<string> {
    [Symbol.asyncIterator](): AsyncIterator<string>;
  }
  export class Writable {
    write(chunk: string, cb: (err?: Error | null) => void): boolean;
    end(cb?: () => void): void;
    once(event: "error", cb: (err: Error) => void): void;
  }
}

declare module "node:fs" {
  import { Readable, Writable } from "node:stream";
  export function createReadStream(path: string, options?: { encoding?: string }): Readable;
  export function createWriteStream(path: string, options?: { encoding?: string }): Writable;
}

declare module "node:fs/promises" {
  export function readFile(path: string, encoding: "utf8"): Promise<string>;
  export function writeFile(path: string, data: string, encoding?: "utf8"): Promise<void>;
  export function rename(from: string, to: string): Promise<void>;
  export function rm(path: string, options?: { force?: boolean; recursive?: boolean }): Promise<void>;
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  export function stat(path: string): Promise<{ size: number; mtimeMs: number }>;
  export function readdir(path: string): Promise<string[]>;
  export function mkdtemp(prefix: string): Promise<string>;
}

declare module "node:readline" {
  import { Readable } from "node:stream";
  export function createInterface(options: { input: Readable; crlfDelay?: number }): AsyncIterable<string>;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
  export function dirname(p: string): string;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:url" {
  export function pathToFileURL(p: string): { href: string };
}

declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function match(actual: string, regexp: RegExp, message?: string): void;
  export function rejects(promise: Promise<unknown>, validator?: (err: unknown) => boolean): Promise<void>;
}

declare const process: {
  argv: string[];
  exitCode: number;
  cwd(): string;
  stdout: { write(s: string): void };
  stderr: { write(s: string): void };
};

interface ImportMeta {
  url: string;
}
