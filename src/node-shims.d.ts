// Minimal ambient declarations for the Node.js built-ins used by this
// project, so no external @types/node dependency is required.

declare const console: {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

interface ImportMeta {
  url: string;
}

declare class URL {
  constructor(url: string, base?: string);
  href: string;
  pathname: string;
}

declare const process: {
  argv: string[];
  exit(code?: number): never;
};

declare module 'node:fs' {
  export function readFileSync(path: string, encoding: string): string;
  export function writeFileSync(path: string, data: string): void;
}

declare module 'node:os' {
  export function tmpdir(): string;
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
}

declare module 'node:test' {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module 'node:assert/strict' {
  interface Assert {
    (value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): asserts value;
    throws(fn: () => void, error?: RegExp | ((err: unknown) => boolean), message?: string): void;
    match(actual: string, regexp: RegExp, message?: string): void;
  }
  const assert: Assert;
  export default assert;
}
