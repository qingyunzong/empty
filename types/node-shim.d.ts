// 本环境无法安装 @types/node，这里声明项目用到的 Node.js 内置 API 的最小类型。

declare class Buffer extends Uint8Array {
  toString(encoding?: string): string;
  static from(data: Uint8Array | number[]): Buffer;
  static from(data: string, encoding?: string): Buffer;
  static alloc(size: number): Buffer;
  static concat(list: Uint8Array[]): Buffer;
  static byteLength(data: string, encoding?: string): number;
}

declare class TextDecoder {
  constructor(encoding?: string, options?: { fatal?: boolean });
  decode(input?: Uint8Array): string;
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
  export function fstatSync(fd: number): { size: number };
  export function statSync(path: string): { size: number };
  export function existsSync(path: string): boolean;
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function writeFileSync(path: string, data: string | Uint8Array): void;
  export function appendFileSync(path: string, data: string | Uint8Array): void;
  export function renameSync(from: string, to: string): void;
  export function mkdtempSync(prefix: string): string;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
}

declare module 'node:crypto' {
  export interface Hash {
    update(data: Uint8Array | string): Hash;
    digest(encoding: 'hex' | 'base64'): string;
  }
  export function createHash(algorithm: string): Hash;
}

declare module 'node:os' {
  export function tmpdir(): string;
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
}

declare module 'node:test' {
  function test(name: string, fn: () => void | Promise<void>): void;
  export default test;
}

declare module 'node:assert/strict' {
  export function ok(value: unknown, message?: string): void;
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function strictEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepStrictEqual(actual: unknown, expected: unknown, message?: string): void;
  export function match(value: string, pattern: RegExp, message?: string): void;
  export function throws(
    fn: () => unknown,
    expected?: RegExp | ((err: unknown) => boolean) | (new (...args: never[]) => Error),
    message?: string,
  ): void;
}
