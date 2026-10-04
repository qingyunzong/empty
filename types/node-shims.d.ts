/** 最小 Node 内置模块类型声明（环境无 @types/node，仅声明用到的 API）。 */
declare module "node:fs" {
  export function readFileSync(path: string, encoding: string): string;
}
declare module "node:test" {
  export interface TestContext {
    skip(message?: string): void;
  }
  export function test(name: string, fn: (t: TestContext) => void | Promise<void>): void;
}
declare module "node:assert" {
  interface Assert {
    (value: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    equal(actual: unknown, expected: unknown, message?: string): void;
    strictEqual(actual: unknown, expected: unknown, message?: string): void;
    deepStrictEqual(actual: unknown, expected: unknown, message?: string): void;
    fail(message?: string): never;
    throws(fn: () => void, message?: string): void;
  }
  const assert: Assert;
  export default assert;
}
declare module "node:child_process" {
  export function execFileSync(
    file: string,
    args: string[],
    options?: { encoding?: string; cwd?: string; stdio?: string }
  ): string;
}
declare var process: {
  argv: string[];
  exitCode: number | undefined;
};
