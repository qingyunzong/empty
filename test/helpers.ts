import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Fixture {
  dir: string;
  workdir: string;
  cacheDir: string;
  writeFile: (rel: string, content: string) => void;
}

export function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "orch-"));
  const workdir = join(dir, "work");
  const cacheDir = join(dir, "cache");
  mkdirSync(workdir, { recursive: true });
  mkdirSync(cacheDir, { recursive: true });
  return {
    dir,
    workdir,
    cacheDir,
    writeFile(rel, content) {
      writeFileSync(join(workdir, rel), content);
    },
  };
}

/** Flush pending microtasks so freshly-ready stages reach the executor queue. */
export async function tick(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}
