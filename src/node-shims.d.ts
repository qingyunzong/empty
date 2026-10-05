// 仅声明本工程用到的 Node.js 内置模块（无网络环境，无法安装 @types/node）
declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function existsSync(path: string): boolean;
}
declare module 'node:path' {
  export function join(...parts: string[]): string;
}
declare module 'node:assert/strict' {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function match(value: string, regExp: RegExp, message?: string): void;
}
declare module 'node:test' {
  export default function test(name: string, fn: () => void | Promise<void>): void;
}
declare const process: {
  argv: string[];
  exitCode: number;
  cwd(): string;
};
