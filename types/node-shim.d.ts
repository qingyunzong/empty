declare module "node:fs" {
  export function readFileSync(path: string, encoding: string): string;
}

declare module "node:test" {
  export function test(name: string, fn: () => void): void;
}

declare module "node:assert/strict" {
  const assert: {
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    throws(fn: () => void, pattern?: RegExp): void;
  };
  export default assert;
}

declare const process: {
  argv: string[];
  exit(code?: number): never;
  cwd(): string;
};

declare const __dirname: string;
