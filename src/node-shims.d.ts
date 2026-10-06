// 环境无 @types/node（离线），此处声明本项目用到的最小 Node API。
declare module "node:fs" {
  export function readFileSync(path: string, encoding: string): string;
  export function writeFileSync(path: string, data: string): void;
}
declare module "node:test" {
  export default function test(name: string, fn: () => void | Promise<void>): void;
}
declare module "node:assert/strict" {
  export function equal(a: unknown, b: unknown, msg?: string): void;
  export function notEqual(a: unknown, b: unknown, msg?: string): void;
  export function deepEqual(a: unknown, b: unknown, msg?: string): void;
  export function ok(v: unknown, msg?: string): void;
  export function throws(fn: () => void, error?: string | RegExp | ((e: unknown) => boolean), msg?: string): void;
}
declare const process: { argv: string[]; exitCode: number | undefined };
