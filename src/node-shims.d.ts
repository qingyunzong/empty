// 无网络环境，无法安装 @types/node；此处提供本项目用到的最小类型声明。
declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
}

declare module "node:child_process" {
  export interface SpawnSyncResult {
    status: number | null;
    stdout: string;
    stderr: string;
  }
  export function spawnSync(
    command: string,
    args?: readonly string[],
    options?: { encoding?: string }
  ): SpawnSyncResult;
}

declare const process: {
  argv: string[];
  execPath: string;
  exitCode: number | undefined;
};

declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};
