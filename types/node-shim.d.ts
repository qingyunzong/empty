// 离线环境下的最小 Node.js 内置库类型声明（仅覆盖本项目用到的 API）。
// 有网络时可替换为正式的 @types/node。

declare module 'node:fs' {
  export function readFileSync(path: string, encoding: string): string;
  export function writeFileSync(path: string, data: string): void;
  export function mkdtempSync(prefix: string): string;
}

declare module 'node:os' {
  export function tmpdir(): string;
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
}

declare module 'node:child_process' {
  export interface SpawnSyncResult {
    status: number | null;
    stdout: string;
    stderr: string;
  }
  export function spawnSync(command: string, args?: string[], options?: { encoding?: string }): SpawnSyncResult;
}

declare module 'node:test' {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module 'node:assert/strict' {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): asserts value;
  export function throws(fn: () => void, pattern?: RegExp): void;
  export function match(value: string, pattern: RegExp, message?: string): void;
  const assert: {
    equal: typeof equal;
    deepEqual: typeof deepEqual;
    ok: typeof ok;
    throws: typeof throws;
    match: typeof match;
  };
  export default assert;
}

declare const process: {
  argv: string[];
  exitCode: number | undefined;
  exit(code?: number): never;
};
