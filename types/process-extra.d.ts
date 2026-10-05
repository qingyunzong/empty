// Augmentations kept separate from the main shim for clarity.
declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  exitCode: number | undefined;
  exit(code?: number): never;
  execPath: string;
  cwd(): string;
  stdin: { on(event: string, cb: (chunk?: unknown) => void): void };
  stdout: { write(text: string): void };
  stderr: { write(text: string): void };
};

declare const __dirname: string;
