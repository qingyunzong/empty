import { randomBytes } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { sha256, stableStringify } from './digest.js';

export interface CacheRecord {
  stageId: string;
  digest: string;
  value: unknown;
  /** Integrity tag: sha256 of the stable stringification of `value`. */
  valueHash: string;
  publishedAt: string;
}

export function makeRecord(stageId: string, digest: string, value: unknown): CacheRecord {
  return {
    stageId,
    digest,
    value,
    valueHash: sha256(stableStringify(value)),
    publishedAt: new Date().toISOString(),
  };
}

export interface PublishHooks {
  /** Fires after the temp file is fsynced, before the atomic rename. */
  afterTmpWrite?: () => void;
}

/**
 * Content-addressed cache of stage results. A record is only visible after an
 * atomic rename, so a crash mid-publish can never expose a partial entry.
 */
export class CacheStore {
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private keyOf(stageId: string, digest: string): string {
    return join(this.dir, `${encodeURIComponent(stageId)}-${digest}.json`);
  }

  /**
   * Returns the record only when it passes integrity validation; tampered or
   * stale records (digest/stageId/value mismatch) are treated as a miss.
   */
  lookup(stageId: string, digest: string): CacheRecord | null {
    let record: CacheRecord;
    try {
      record = JSON.parse(readFileSync(this.keyOf(stageId, digest), 'utf8')) as CacheRecord;
    } catch {
      return null;
    }
    if (record.stageId !== stageId || record.digest !== digest) return null;
    if (sha256(stableStringify(record.value)) !== record.valueHash) return null;
    return record;
  }

  /** Write temp file -> fsync -> atomic rename -> fsync directory. */
  publish(record: CacheRecord, hooks?: PublishHooks): void {
    const key = this.keyOf(record.stageId, record.digest);
    const tmp = `${key}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
    const fd = openSync(tmp, 'w');
    try {
      writeSync(fd, JSON.stringify(record));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    hooks?.afterTmpWrite?.();
    renameSync(tmp, key);
    const dirFd = openSync(this.dir, 'r');
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  }

  /** Remove leftover temp files from crashed publishes. */
  sweep(): number {
    let removed = 0;
    for (const entry of readdirSync(this.dir)) {
      if (entry.includes('.tmp-')) {
        unlinkSync(join(this.dir, entry));
        removed += 1;
      }
    }
    return removed;
  }

  /** Names of committed cache entries (test/diagnostic aid). */
  entries(): string[] {
    return readdirSync(this.dir).filter((entry) => !entry.includes('.tmp-'));
  }
}
