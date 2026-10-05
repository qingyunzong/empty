import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeSync, } from 'node:fs';
import { join } from 'node:path';
import { sha256, stableStringify } from './digest.js';
export function makeRecord(stageId, digest, value) {
    return {
        stageId,
        digest,
        value,
        valueHash: sha256(stableStringify(value)),
        publishedAt: new Date().toISOString(),
    };
}
/**
 * Content-addressed cache of stage results. A record is only visible after an
 * atomic rename, so a crash mid-publish can never expose a partial entry.
 */
export class CacheStore {
    dir;
    constructor(dir) {
        this.dir = dir;
        mkdirSync(dir, { recursive: true });
    }
    keyOf(stageId, digest) {
        return join(this.dir, `${encodeURIComponent(stageId)}-${digest}.json`);
    }
    /**
     * Returns the record only when it passes integrity validation; tampered or
     * stale records (digest/stageId/value mismatch) are treated as a miss.
     */
    lookup(stageId, digest) {
        let record;
        try {
            record = JSON.parse(readFileSync(this.keyOf(stageId, digest), 'utf8'));
        }
        catch {
            return null;
        }
        if (record.stageId !== stageId || record.digest !== digest)
            return null;
        if (sha256(stableStringify(record.value)) !== record.valueHash)
            return null;
        return record;
    }
    /** Write temp file -> fsync -> atomic rename -> fsync directory. */
    publish(record, hooks) {
        const key = this.keyOf(record.stageId, record.digest);
        const tmp = `${key}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
        const fd = openSync(tmp, 'w');
        try {
            writeSync(fd, JSON.stringify(record));
            fsyncSync(fd);
        }
        finally {
            closeSync(fd);
        }
        hooks?.afterTmpWrite?.();
        renameSync(tmp, key);
        const dirFd = openSync(this.dir, 'r');
        try {
            fsyncSync(dirFd);
        }
        finally {
            closeSync(dirFd);
        }
    }
    /** Remove leftover temp files from crashed publishes. */
    sweep() {
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
    entries() {
        return readdirSync(this.dir).filter((entry) => !entry.includes('.tmp-'));
    }
}
