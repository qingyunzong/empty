// 离线环境无 @types/node，这里为用到的 Node.js 内置模块提供最小类型声明。
declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): asserts value;
  export function throws(fn: () => unknown, message?: string): void;
  const assert: {
    equal: typeof equal;
    deepEqual: typeof deepEqual;
    ok: typeof ok;
    throws: typeof throws;
  };
  export default assert;
}

declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
}

declare module "node:crypto" {
  export interface Hash {
    update(data: string): Hash;
    digest(encoding: "hex"): string;
  }
  export function createHash(algorithm: string): Hash;
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

declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
  export function pathToFileURL(path: string): URL;
}

declare module "node:child_process" {
  export interface ExecFileSyncResult {
    status: number | null;
    stdout: string;
    stderr: string;
  }
  export function execFileSync(
    file: string,
    args: string[],
    options: { encoding: "utf8"; input?: string }
  ): string;
  export function spawnSync(
    file: string,
    args: string[],
    options: { encoding: "utf8"; input?: string }
  ): ExecFileSyncResult;
}

declare var process: {
  argv: string[];
  execPath: string;
  exitCode: number | undefined;
  stdin: { fd: number };
  cwd(): string;
  exit(code?: number): never;
};

declare var console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

declare class URL {
  constructor(url: string, base?: string | URL);
  href: string;
}

interface ImportMeta {
  url: string;
}
