declare class URL {
  constructor(url: string, base?: string | URL);
  pathname: string;
  href: string;
}

interface ImportMeta {
  url: string;
}

declare module "node:buffer" {
  export class Buffer extends Uint8Array {
    static from(data: readonly number[]): Buffer;
    static from(data: Uint8Array): Buffer;
    static from(data: string, encoding?: "utf8" | "hex" | "base64"): Buffer;
    static concat(list: readonly Uint8Array[]): Buffer;
    static isBuffer(value: unknown): value is Buffer;
    readUInt8(offset: number): number;
    readUInt16LE(offset: number): number;
    readUInt16BE(offset: number): number;
    readUInt32LE(offset: number): number;
    readUInt32BE(offset: number): number;
    subarray(start?: number, end?: number): Buffer;
    toString(encoding?: "utf8" | "hex" | "base64"): string;
  }
}

declare module "node:test" {
  export interface TestContext {
    diagnostic(message: string): void;
  }
  export function test(name: string, fn: (t: TestContext) => void | Promise<void>): void;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): asserts value;
  export function fail(message?: string): never;
  export function throws(
    fn: () => unknown,
    check?: RegExp | ((err: unknown) => boolean) | (new (...args: never[]) => unknown),
    message?: string
  ): void;
}

declare module "node:fs" {
  export function readFileSync(path: string): import("node:buffer").Buffer;
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function writeFileSync(path: string, data: string | Uint8Array): void;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
}

declare module "node:process" {
  export interface Process {
    argv: string[];
    execPath: string;
    exitCode: number;
    stdout: { write(chunk: string): void };
    stderr: { write(chunk: string): void };
  }
  const process: Process;
  export default process;
}

declare module "node:child_process" {
  export interface SpawnSyncResult {
    status: number | null;
    stdout: import("node:buffer").Buffer;
    stderr: import("node:buffer").Buffer;
    error?: unknown;
  }
  export function spawnSync(
    command: string,
    args?: readonly string[],
    options?: { cwd?: string; input?: string | Uint8Array }
  ): SpawnSyncResult;
}

declare module "node:url" {
  export function pathToFileURL(path: string): URL;
}
