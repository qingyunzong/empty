import {
  chmodSync,
  mkdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import type { Publisher, StagedFile } from "./types";

const STAGING_DIR_MODE = 0o700; // owner-only: intermediate staging is not readable by others
const STAGING_FILE_MODE = 0o600;

function tryRemoveDirIfEmpty(dir: string): void {
  try {
    rmdirSync(dir);
  } catch {
    // non-empty or already gone: leave it
  }
}

/**
 * File-system publisher.
 *
 * Staging files are written into a private `.staging` directory (mode 0700)
 * next to the target, with file mode 0600, so intermediate content is not
 * readable by anyone but the owner. Commit is an atomic rename within the
 * same filesystem, so the target path is never observed half-written and a
 * pre-existing target file survives any failure before the rename.
 */
export class FsPublisher implements Publisher {
  /** @param stagingDir override for the staging directory (must share the target's filesystem). */
  constructor(private readonly stagingDir?: string) {}

  async stage(targetPath: string, content: string): Promise<StagedFile> {
    const dir = this.stagingDir ?? join(dirname(targetPath), ".staging");
    mkdirSync(dir, { recursive: true, mode: STAGING_DIR_MODE });
    chmodSync(dir, STAGING_DIR_MODE); // enforce even if the dir already existed

    const stagingPath = join(dir, `${basename(targetPath)}.${randomUUID()}.tmp`);
    writeFileSync(stagingPath, content, { mode: STAGING_FILE_MODE });
    chmodSync(stagingPath, STAGING_FILE_MODE); // enforce regardless of umask

    return {
      stagingPath,
      commit: async () => {
        renameSync(stagingPath, targetPath);
        tryRemoveDirIfEmpty(dir);
      },
      abort: async () => {
        rmSync(stagingPath, { force: true });
        tryRemoveDirIfEmpty(dir);
      },
    };
  }
}
