// Minimal ambient declarations for the Node.js built-in APIs used by this
// project. They exist because @types/node cannot be installed in the offline
// environment; they intentionally cover only what src/ and test/ touch.

type BufferEncoding = 'utf8' | 'utf16le' | 'latin1' | 'ascii' | 'hex' | 'base64';

declare var Buffer: {
  alloc(size: number): Buffer;
  allocUnsafe(size: number): Buffer;
  from(data: string, encoding?: BufferEncoding): Buffer;
  from(data: Uint8Array): Buffer;
  concat(list: Uint8Array[]): Buffer;
  byteLength(text: string, encoding?: BufferEncoding): number;
  prototype: Buffer;
};

interface Buffer extends Uint8Array {
  indexOf(value: number | string | Uint8Array, byteOffset?: number): number;
  subarray(start?: number, end?: number): Buffer;
  toString(encoding?: BufferEncoding): string;
}

declare module 'node:crypto' {
  export interface Hash {
    update(data: Uint8Array | string): Hash;
    digest(encoding?: 'hex'): string;
    copy(): Hash;
  }
  export function createHash(algorithm: string): Hash;
}

declare module 'node:fs' {
  export function openSync(path: string, flags: string): number;
  export function closeSync(fd: number): void;
  export function readSync(
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ): number;
  export function existsSync(path: string): boolean;
  export function readFileSync(path: string, encoding: BufferEncoding): string;
  export function readFileSync(path: string): Buffer;
  export function writeFileSync(path: string, data: string | Uint8Array): void;
  export function appendFileSync(path: string, data: string | Uint8Array): void;
  export function renameSync(from: string, to: string): void;
  export function statSync(path: string): { size: number };
  export function mkdtempSync(prefix: string): string;
  export function rmSync(
    path: string,
    options?: { recursive?: boolean; force?: boolean },
  ): void;
}

declare module 'node:os' {
  export function tmpdir(): string;
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
}

declare module 'node:test' {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module 'node:assert/strict' {
  const assert: {
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    match(value: string, regExp: RegExp, message?: string): void;
    throws(fn: () => unknown, error?: unknown, message?: string): void;
  };
  export default assert;
}
