// Minimal ambient declarations for the Node.js built-ins used by this
// project. The sandbox has no network access, so @types/node cannot be
// installed; these cover exactly the APIs exercised by src/ and test/.

declare class Buffer {
  static from(data: string, encoding?: string): Buffer;
  static concat(list: Buffer[]): Buffer;
  readonly length: number;
  toString(encoding?: string): string;
}

interface ImportMeta {
  url: string;
}

declare const process: {
  argv: string[];
  execPath: string;
  env: Record<string, string | undefined>;
  pid: number;
  cwd(): string;
  exit(code?: number): never;
};

declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function readFileSync(path: string): Buffer;
  export function writeFileSync(path: string, data: string): void;
  export function appendFileSync(path: string, data: string): void;
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, opts?: { recursive?: boolean }): void;
  export function readdirSync(path: string): string[];
  export function unlinkSync(path: string): void;
  export function renameSync(from: string, to: string): void;
  export function mkdtempSync(prefix: string): string;
  export function rmSync(path: string, opts?: { recursive?: boolean; force?: boolean }): void;
  export function openSync(path: string, flags: string): number;
  export function fsyncSync(fd: number): void;
  export function closeSync(fd: number): void;
  export function writeSync(fd: number, data: string): number;
}

declare module 'node:crypto' {
  export interface Hash {
    update(data: string | Buffer): Hash;
    digest(encoding: 'hex'): string;
  }
  export function createHash(algorithm: string): Hash;
  export function randomBytes(size: number): Buffer;
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
  export function dirname(p: string): string;
  export function basename(p: string): string;
}

declare module 'node:os' {
  export function tmpdir(): string;
}

declare module 'node:url' {
  export function fileURLToPath(url: string): string;
}

declare module 'node:child_process' {
  export interface SpawnSyncResult {
    status: number | null;
    stdout: Buffer;
    stderr: Buffer;
    error?: Error;
  }
  export function spawnSync(
    command: string,
    args: string[],
    options: { env?: Record<string, string | undefined>; encoding?: string }
  ): SpawnSyncResult;
}

declare module 'node:test' {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
}

declare module 'node:assert/strict' {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function throws(fn: () => void, match?: RegExp | ((err: unknown) => boolean)): void;
  export function rejects(fn: () => Promise<unknown>, match?: RegExp | ((err: unknown) => boolean)): Promise<void>;
}
