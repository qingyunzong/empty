// Minimal ambient declarations for the Node.js built-ins we use.
// The sandbox has no @types/node and no network access, so we declare
// exactly the surface this project needs. Node.js built-ins only.

declare var process: {
  argv: string[];
  exitCode?: number;
  cwd(): string;
  exit(code?: number): never;
  stdout: { write(s: string): void };
  stderr: { write(s: string): void };
};

declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function writeFileSync(path: string, data: string): void;
}

declare module "node:assert/strict" {
  export function equal(a: unknown, b: unknown, msg?: string): void;
  export function deepEqual(a: unknown, b: unknown, msg?: string): void;
  export function ok(v: unknown, msg?: string): void;
  export function throws(fn: () => void, re?: unknown): void;
  const assert: {
    (v: unknown, msg?: string): void;
    equal: typeof equal;
    deepEqual: typeof deepEqual;
    ok: typeof ok;
    throws: typeof throws;
  };
  export default assert;
}

declare module "node:test" {
  type TestFn = () => void | Promise<void>;
  export function test(name: string, fn: TestFn): void;
  export default test;
}

declare module "node:child_process" {
  export interface ExecFileResult {
    stdout: string;
    stderr: string;
  }
  export function execFileSync(
    file: string,
    args: string[],
    opts?: { encoding?: string; cwd?: string }
  ): string;
}
