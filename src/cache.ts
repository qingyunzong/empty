import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { canonicalize, sha256 } from "./digest.js";

export interface CachePayload {
  stage: string;
  digest: string;
  outputHash: string;
  output: unknown;
}

interface Envelope {
  payload: CachePayload;
  checksum: string;
}

/** Simulated power cut: thrown by fault-injection hooks mid-commit. */
export class PowerFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PowerFailure";
  }
}

export interface WriteFaults {
  afterTmpWrite?: (tmpPath: string) => void;
  afterRename?: (finalPath: string) => void;
}

let tmpCounter = 0;

/**
 * Atomic publish: write tmp file, fsync it, rename over the target, fsync the
 * directory. A crash at any point leaves either the old complete file or a
 * harmless `*.tmp` orphan — never a truncated final file.
 */
export function atomicWriteFileSync(finalPath: string, data: string, faults: WriteFaults = {}): void {
  const dir = join(finalPath, "..");
  const tmp = join(dir, `.tmp.${process.pid}.${tmpCounter++}`);
  const fd = openSync(tmp, "w");
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  faults.afterTmpWrite?.(tmp);
  renameSync(tmp, finalPath);
  faults.afterRename?.(finalPath);
  const dirFd = openSync(dir, "r");
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}

function isValidEnvelope(value: unknown): value is Envelope {
  if (value === null || typeof value !== "object") return false;
  const env = value as Record<string, unknown>;
  if (typeof env.checksum !== "string") return false;
  const payload = env.payload;
  if (payload === null || typeof payload !== "object") return false;
  const p = payload as Record<string, unknown>;
  return (
    typeof p.stage === "string" &&
    typeof p.digest === "string" &&
    typeof p.outputHash === "string" &&
    "output" in p
  );
}

/**
 * Content-addressed success cache. Records are self-validating (checksum over
 * the canonical payload); corrupt or torn records are treated as a cache miss
 * and removed, so a stale/partial success is never reused.
 */
export class CacheStore {
  constructor(
    readonly dir: string,
    private readonly faults: WriteFaults = {},
  ) {
    mkdirSync(dir, { recursive: true });
  }

  private finalPath(stage: string): string {
    return join(this.dir, `${stage}.json`);
  }

  read(stage: string): CachePayload | null {
    const file = this.finalPath(stage);
    if (!existsSync(file)) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      this.silentRemove(file);
      return null;
    }
    if (!isValidEnvelope(parsed)) {
      this.silentRemove(file);
      return null;
    }
    if (parsed.checksum !== sha256(canonicalize(parsed.payload))) {
      this.silentRemove(file);
      return null;
    }
    if (parsed.payload.stage !== stage) {
      this.silentRemove(file);
      return null;
    }
    return parsed.payload;
  }

  write(payload: CachePayload): void {
    const envelope: Envelope = { payload, checksum: sha256(canonicalize(payload)) };
    atomicWriteFileSync(this.finalPath(payload.stage), JSON.stringify(envelope), this.faults);
  }

  /** Remove `*.tmp` orphans left behind by a crash mid-commit. */
  cleanOrphans(): string[] {
    const removed: string[] = [];
    for (const entry of readdirSync(this.dir)) {
      if (entry.startsWith(".tmp.")) {
        unlinkSync(join(this.dir, entry));
        removed.push(entry);
      }
    }
    return removed;
  }

  private silentRemove(file: string): void {
    try {
      unlinkSync(file);
    } catch {
      /* already gone */
    }
  }
}
