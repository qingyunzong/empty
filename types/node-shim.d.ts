/**
 * Minimal ambient declarations for the Node.js built-in modules used by this
 * project. The environment has no registry access, so @types/node cannot be
 * installed; these cover exactly the APIs in use.
 */

declare var console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

declare var process: {
  argv: string[];
  exit(code?: number): never;
  cwd(): string;
};

declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
}

declare module 'node:util' {
  interface ParseArgsOptionConfig {
    type: 'string' | 'boolean';
    default?: string | boolean;
  }
  interface ParseArgsConfig {
    options?: Record<string, ParseArgsOptionConfig>;
    allowPositionals?: boolean;
  }
  interface ParseArgsResult {
    values: Record<string, string | boolean | undefined>;
    positionals: string[];
  }
  export function parseArgs(config: ParseArgsConfig): ParseArgsResult;
}

declare module 'node:test' {
  type TestFn = () => void | Promise<void>;
  export function test(name: string, fn: TestFn): void;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: TestFn): void;
}

declare module 'node:assert/strict' {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function throws(fn: () => void, expected?: RegExp | ((err: Error) => boolean), message?: string): void;
  export function match(actual: string, regexp: RegExp, message?: string): void;
}
