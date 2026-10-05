declare module "node:fs/promises" {
  export interface FileHandle {
    writeFile(data: string | Uint8Array): Promise<void>;
    sync(): Promise<void>;
    close(): Promise<void>;
  }
  export interface Stats {
    readonly mode: number;
    readonly size: number;
  }
  export function open(path: string, flags: string, mode?: number): Promise<FileHandle>;
  export function chmod(path: string, mode: number): Promise<void>;
  export function rename(oldPath: string, newPath: string): Promise<void>;
  export function rm(path: string, options?: { force?: boolean; recursive?: boolean }): Promise<void>;
  export function mkdtemp(prefix: string): Promise<string>;
  export function readFile(path: string, encoding: "utf8"): Promise<string>;
  export function writeFile(path: string, data: string): Promise<void>;
  export function stat(path: string): Promise<Stats>;
  export function readdir(path: string): Promise<string[]>;
}

declare module "node:crypto" {
  export function randomUUID(): string;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
  export function dirname(path: string): string;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function rejects(promise: Promise<unknown>, matcher?: (error: unknown) => boolean): Promise<void>;
}

declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare const process: {
  readonly pid: number;
  getuid?: () => number;
};

declare const Buffer: {
  byteLength(text: string): number;
};
