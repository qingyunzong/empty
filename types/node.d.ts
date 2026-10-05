// 本工程仅使用 Node.js 内置库；此处为所需 API 的最小类型声明（无外部依赖）。
declare module 'node:crypto' {
  export interface Hash {
    update(data: string, encoding: string): Hash;
    digest(encoding: 'hex'): string;
  }
  export function createHash(algorithm: string): Hash;
}

declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function writeFileSync(path: string, data: string): void;
}

declare module 'node:test' {
  export function test(name: string, fn: () => void): void;
}

declare module 'node:assert/strict' {
  interface Assert {
    (value: unknown, message?: string): void;
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    throws(fn: () => void, pattern?: RegExp, message?: string): void;
    match(actual: string, pattern: RegExp, message?: string): void;
  }
  const assert: Assert;
  export default assert;
}

declare module 'node:child_process' {
  export function execFileSync(file: string, args: string[], options: { encoding: 'utf8' }): string;
}

declare var process: {
  argv: string[];
  execPath: string;
  exitCode: number | undefined;
  stdout: { write(data: string): void };
};

declare var console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};
