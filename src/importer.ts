import { createHash } from 'node:crypto';
import type { Hash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';

const NEWLINE = 0x0a;
const READ_CHUNK = 64 * 1024;

export class SourceModifiedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceModifiedError';
  }
}

export class CheckpointCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckpointCorruptError';
  }
}

export interface Checkpoint {
  /** Absolute byte offset of the first unconsumed byte in the source file. */
  offset: number;
  /** Total number of records consumed so far. */
  records: number;
  /** SHA-256 hex digest of source bytes [0, offset). */
  digest: string;
}

export interface ImportOptions {
  /** Path of the checkpoint file (JSON, written atomically). */
  checkpointPath: string;
  /** Records per batch before a checkpoint is persisted. Default 100. */
  batchSize?: number;
  /** Stop after this many batches in one run (used to pause/resume). */
  maxBatches?: number;
  /** Text encoding of the source. Default 'utf8'. */
  encoding?: BufferEncoding;
  /** Called once per batch, before the checkpoint is persisted. */
  onBatch?: (records: string[], checkpoint: Checkpoint) => void;
}

export interface ImportResult {
  /** Records processed in this run. */
  records: number;
  /** Batches processed in this run. */
  batches: number;
  /** True when this run resumed from an existing checkpoint. */
  resumed: boolean;
  /** True when the whole source file has been consumed. */
  complete: boolean;
  /** Checkpoint state at the end of this run. */
  checkpoint: Checkpoint;
}

function loadCheckpoint(path: string): Checkpoint | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new CheckpointCorruptError(`checkpoint is not valid JSON: ${path}`);
  }
  const c = parsed as Checkpoint;
  if (
    c === null ||
    typeof c !== 'object' ||
    typeof c.offset !== 'number' ||
    !Number.isInteger(c.offset) ||
    c.offset < 0 ||
    typeof c.records !== 'number' ||
    typeof c.digest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(c.digest)
  ) {
    throw new CheckpointCorruptError(`checkpoint has an invalid shape: ${path}`);
  }
  return c;
}

function saveCheckpoint(path: string, checkpoint: Checkpoint): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(checkpoint, null, 2));
  renameSync(tmp, path);
}

/** Hash the first `length` bytes of `fd`; returns the running Hash so callers can keep updating it. */
function hashPrefix(fd: number, length: number): Hash {
  const hash = createHash('sha256');
  const buf = Buffer.allocUnsafe(Math.min(READ_CHUNK, Math.max(length, 1)));
  let position = 0;
  while (position < length) {
    const want = Math.min(buf.length, length - position);
    const got = readSync(fd, buf, 0, want, position);
    if (got <= 0) {
      throw new SourceModifiedError('source shrank while it was being verified');
    }
    hash.update(buf.subarray(0, got));
    position += got;
  }
  return hash;
}

/**
 * Import newline-delimited records from `sourcePath` in batches, persisting a
 * checkpoint (byte offset + SHA-256 of the consumed prefix) after every batch.
 *
 * Resume rules:
 *  - bytes [0, checkpoint.offset) must hash to checkpoint.digest, otherwise the
 *    source was modified mid-file and a SourceModifiedError is thrown;
 *  - a source that is shorter than the checkpoint offset is rejected;
 *  - a source that only grew at the tail is imported from the checkpoint offset.
 *
 * Checkpoints land only on record boundaries (just past a 0x0A byte), so a
 * multi-byte character is never split across a checkpoint and no record is
 * ever recorded twice.
 */
export function importFile(sourcePath: string, options: ImportOptions): ImportResult {
  const batchSize = options.batchSize ?? 100;
  const maxBatches = options.maxBatches ?? Number.POSITIVE_INFINITY;
  const encoding = options.encoding ?? 'utf8';
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new RangeError('batchSize must be a positive integer');
  }

  const stat = statSync(sourcePath);
  const prior = loadCheckpoint(options.checkpointPath);

  const fd = openSync(sourcePath, 'r');
  try {
    let offset = 0;
    let recordsTotal = 0;
    let hash: Hash;
    let resumed = false;

    if (prior) {
      if (stat.size < prior.offset) {
        throw new SourceModifiedError(
          `source is ${stat.size} bytes but checkpoint offset is ${prior.offset}: ` +
            'file was truncated or replaced',
        );
      }
      hash = hashPrefix(fd, prior.offset);
      if (hash.copy().digest('hex') !== prior.digest) {
        throw new SourceModifiedError(
          'source bytes before the checkpoint offset changed: ' +
            'mid-file modification is not allowed',
        );
      }
      offset = prior.offset;
      recordsTotal = prior.records;
      resumed = true;
    } else {
      hash = createHash('sha256');
    }

    let pending = Buffer.alloc(0);
    let batch: string[] = [];
    let batches = 0;
    let recordsThisRun = 0;
    let complete = false;

    const flushBatch = (): boolean => {
      if (batch.length === 0) return true;
      const checkpoint: Checkpoint = {
        offset,
        records: recordsTotal,
        digest: hash.copy().digest('hex'),
      };
      options.onBatch?.(batch, checkpoint);
      saveCheckpoint(options.checkpointPath, checkpoint);
      batches += 1;
      batch = [];
      return batches < maxBatches;
    };

    const readBuf = Buffer.allocUnsafe(READ_CHUNK);
    let position = offset;

    outer: while (true) {
      const got = readSync(fd, readBuf, 0, READ_CHUNK, position);
      if (got === 0) {
        flushBatch();
        complete = pending.length === 0;
        break;
      }
      position += got;
      pending =
        pending.length === 0
          ? Buffer.from(readBuf.subarray(0, got))
          : Buffer.concat([pending, readBuf.subarray(0, got)]);

      let start = 0;
      let nl: number;
      while ((nl = pending.indexOf(NEWLINE, start)) !== -1) {
        const line = pending.subarray(start, nl);
        hash.update(pending.subarray(start, nl + 1));
        const text = line.toString(encoding);
        batch.push(text.endsWith('\r') ? text.slice(0, -1) : text);
        recordsTotal += 1;
        recordsThisRun += 1;
        start = nl + 1;
        if (batch.length >= batchSize) {
          offset += start;
          pending = pending.subarray(start);
          start = 0;
          if (!flushBatch()) break outer;
        }
      }
      offset += start;
      pending = pending.subarray(start);
    }

    return {
      records: recordsThisRun,
      batches,
      resumed,
      complete,
      checkpoint: {
        offset,
        records: recordsTotal,
        digest: hash.copy().digest('hex'),
      },
    };
  } finally {
    closeSync(fd);
  }
}
