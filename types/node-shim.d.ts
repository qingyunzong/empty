// Minimal ambient declarations for the Node.js built-ins used by this
// project, so `tsc` type-checks without installing @types/node (offline env).

declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function writeFileSync(path: string, data: string): void;
  export function mkdtempSync(prefix: string): string;
  export function rmSync(path: string, opts?: { recursive?: boolean; force?: boolean }): void;
}

declare module 'node:util' {
  export function parseArgs(config: {
    args: string[];
    allowPositionals?: boolean;
    options?: Record<string, { type: 'string' | 'boolean'; default?: unknown }>;
  }): { values: Record<string, any>; positionals: string[] };
}

declare module 'node:test' {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module 'node:assert/strict' {
  const assert: {
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
  };
  export = assert;
}

declare module 'node:child_process' {
  export function spawnSync(
    cmd: string,
    args: string[],
    opts?: { encoding?: 'utf8' },
  ): { status: number | null; stdout: string; stderr: string };
}

declare module 'node:os' {
  export function tmpdir(): string;
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
}

declare const process: {
  argv: string[];
  execPath: string;
  exit(code?: number): never;
  stdout: { write(s: string): void };
  stderr: { write(s: string): void };
  cwd(): string;
};

declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};
