// 最小 Node 类型声明（环境离线，无法安装 @types/node）
declare const process: {
  argv: string[];
  exitCode?: number;
  stdin: { fd: number };
  stdout: { write(s: string): void };
  stderr: { write(s: string): void };
};

declare module "node:fs" {
  export function readFileSync(path: string | number, encoding: string): string;
  export function existsSync(path: string): boolean;
}

declare module "node:test" {
  type TestFn = () => void | Promise<void>;
  export function test(name: string, fn: TestFn): void;
  export function describe(name: string, fn: () => void): void;
  export default test;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function throws(fn: () => void, message?: string): void;
}

declare module "node:child_process" {
  export function execFileSync(
    cmd: string,
    args?: string[],
    opts?: { encoding?: string; input?: string; cwd?: string }
  ): string;
}

declare const module: { id: string };
declare const require: { main?: { id: string } };
