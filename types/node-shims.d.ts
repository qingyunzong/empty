// 离线环境下的最小 Node.js 内置库类型声明（仅覆盖本项目用到的 API）。
declare module "node:fs" {
  export function readFileSync(path: string, encoding: string): string;
}

declare module "node:assert/strict" {
  interface Assert {
    (value: unknown, message?: string): void;
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    throws(fn: () => unknown, pattern?: RegExp, message?: string): void;
  }
  const assert: Assert;
  export default assert;
}

declare module "node:test" {
  export default function test(name: string, fn: () => void): void;
}

declare const process: {
  argv: string[];
  exit(code: number): never;
};

declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};
