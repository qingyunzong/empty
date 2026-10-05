import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { digestBytes, type Digest } from './digest.js';
import type { Entry } from './entry.js';
import { BackupStore } from './store.js';
import { ExternalModificationError, IntegrityError, type StateMismatch } from './errors.js';

export interface VerifiedPath {
  path: string;
  digest: Digest | null;
}

export interface BatchResult {
  direction: 'undo' | 'redo';
  entries: readonly Entry[];
  /** Final on-disk state of every touched path, re-verified after applying. */
  verified: readonly VerifiedPath[];
}

/**
 * One expected state transition of a single path. `expect` is the digest the
 * path must currently have (`null` = must be absent); `becomes` is the digest
 * it will have after the step (`null` = will be absent).
 */
interface Step {
  path: string;
  expect: Digest | null;
  becomes: Digest | null;
}

/** Inverse (undo) transitions for one journal entry. */
function inverseSteps(entry: Entry): Step[] {
  switch (entry.kind) {
    case 'create':
      return [{ path: entry.path, expect: entry.after, becomes: null }];
    case 'write':
      return [{ path: entry.path, expect: entry.after, becomes: entry.before }];
    case 'delete':
      return [{ path: entry.path, expect: null, becomes: entry.before }];
    case 'move':
      return [
        { path: entry.to, expect: entry.after, becomes: entry.overwritten },
        { path: entry.from, expect: null, becomes: entry.before },
      ];
  }
}

/** Forward (redo / replay) transitions for one journal entry. */
function forwardSteps(entry: Entry): Step[] {
  switch (entry.kind) {
    case 'create':
      return [{ path: entry.path, expect: null, becomes: entry.after }];
    case 'write':
      return [{ path: entry.path, expect: entry.before, becomes: entry.after }];
    case 'delete':
      return [{ path: entry.path, expect: entry.before, becomes: null }];
    case 'move':
      return [
        { path: entry.from, expect: entry.before, becomes: null },
        { path: entry.to, expect: entry.overwritten, becomes: entry.after },
      ];
  }
}

function toBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === 'string' ? new TextEncoder().encode(content) : content;
}

function ensureParent(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

/**
 * Journaling file-operation facade with snapshot-based undo/redo.
 *
 * Every mutating method records a journal entry holding the SHA-256 digests
 * of the before-image and the after-image; the bytes themselves are kept in
 * a content-addressed backup store. Undo only proceeds while the current
 * on-disk state equals the recorded after-image, and a batch undo/redo first
 * verifies the whole batch: a single externally modified path rejects the
 * entire batch before anything on disk is touched. After a batch is applied
 * (replay or inverse replay), every touched path is re-read and its bytes
 * and existence are checked against the expected final state.
 */
export class UndoManager {
  private readonly store = new BackupStore();
  private readonly undoStack: Entry[] = [];
  private readonly redoStack: Entry[] = [];
  private nextId = 1;

  get pendingUndo(): number {
    return this.undoStack.length;
  }

  get pendingRedo(): number {
    return this.redoStack.length;
  }

  get backupCount(): number {
    return this.store.size;
  }

  /** Recorded entries that are currently undoable, oldest first. */
  get journal(): readonly Entry[] {
    return [...this.undoStack];
  }

  // ------------------------------------------------------------------ ops

  /** Creates a new file; fails if `path` already exists. */
  createFile(path: string, content: string | Uint8Array): Entry {
    if (existsSync(path)) {
      throw new Error(`createFile: already exists: ${path}`);
    }
    const data = toBytes(content);
    ensureParent(path);
    writeFileSync(path, data);
    return this.record({ id: 0, kind: 'create', path, after: this.store.put(data) });
  }

  /** Creates or replaces a file, recording whichever actually happened. */
  writeFile(path: string, content: string | Uint8Array): Entry {
    const data = toBytes(content);
    const before = this.snapshot(path);
    if (before !== null) {
      this.store.put(readFileSync(path));
    }
    ensureParent(path);
    writeFileSync(path, data);
    const after = this.store.put(data);
    return before === null
      ? this.record({ id: 0, kind: 'create', path, after })
      : this.record({ id: 0, kind: 'write', path, before, after });
  }

  /** Deletes a file, backing up its bytes first. */
  deleteFile(path: string): Entry {
    const before = this.snapshot(path);
    if (before === null) {
      throw new Error(`deleteFile: no such file: ${path}`);
    }
    this.store.put(readFileSync(path));
    unlinkSync(path);
    return this.record({ id: 0, kind: 'delete', path, before });
  }

  /**
   * Renames `from` to `to`. If `to` exists, its bytes are backed up first so
   * that undoing the move restores the overwritten victim as well.
   */
  moveFile(from: string, to: string): Entry {
    if (from === to) {
      throw new Error(`moveFile: identical source and target: ${from}`);
    }
    const before = this.snapshot(from);
    if (before === null) {
      throw new Error(`moveFile: no such file: ${from}`);
    }
    const overwritten = this.snapshot(to);
    if (overwritten !== null) {
      this.store.put(readFileSync(to));
    }
    ensureParent(to);
    renameSync(from, to);
    const after = this.snapshot(to);
    if (after !== before) {
      throw new IntegrityError([{ entryId: -1, path: to, expected: before, actual: after }]);
    }
    return this.record({ id: 0, kind: 'move', from, to, before, after, overwritten });
  }

  // ------------------------------------------------------------ undo/redo

  /**
   * Undoes the newest `count` entries as one atomic batch. The whole batch
   * is verified against the recorded after-images first; any externally
   * modified path rejects the entire batch with ExternalModificationError
   * and leaves the disk untouched.
   */
  undo(count = 1): BatchResult {
    return this.applyBatch('undo', count);
  }

  /** Replays the newest `count` undone entries as one atomic batch. */
  redo(count = 1): BatchResult {
    return this.applyBatch('redo', count);
  }

  // ------------------------------------------------------------- internals

  private snapshot(path: string): Digest | null {
    return existsSync(path) ? digestBytes(readFileSync(path)) : null;
  }

  private record(entry: Entry): Entry {
    const stored: Entry = { ...entry, id: this.nextId++ };
    this.undoStack.push(stored);
    this.redoStack.length = 0;
    return stored;
  }

  private applyBatch(direction: 'undo' | 'redo', count: number): BatchResult {
    if (!Number.isInteger(count) || count < 1) {
      throw new RangeError(`count must be a positive integer, got ${count}`);
    }
    const source = direction === 'undo' ? this.undoStack : this.redoStack;
    if (count > source.length) {
      throw new RangeError(`cannot ${direction} ${count} entr${count === 1 ? 'y' : 'ies'}; only ${source.length} available`);
    }
    const batch = source.slice(source.length - count);
    const stepsOf = direction === 'undo' ? inverseSteps : forwardSteps;
    const ordered = direction === 'undo' ? [...batch].reverse() : batch;

    // Phase 1: verify the whole batch against a virtual view of the disk.
    // The overlay starts empty and is filled lazily from disk, then updated
    // entry by entry, so chained operations (e.g. move A->B->C) see the
    // intermediate states produced by the entries reverted before them.
    const overlay = new Map<string, Digest | null>();
    const read = (path: string): Digest | null => {
      if (!overlay.has(path)) {
        overlay.set(path, this.snapshot(path));
      }
      return overlay.get(path) ?? null;
    };
    const mismatches: StateMismatch[] = [];
    for (const entry of ordered) {
      for (const step of stepsOf(entry)) {
        const actual = read(step.path);
        if (actual !== step.expect) {
          mismatches.push({ entryId: entry.id, path: step.path, expected: step.expect, actual });
        }
        overlay.set(step.path, step.becomes);
      }
    }
    if (mismatches.length > 0) {
      throw new ExternalModificationError(mismatches);
    }

    // Phase 2: apply the batch.
    for (const entry of ordered) {
      if (direction === 'undo') {
        this.executeInverse(entry);
      } else {
        this.executeForward(entry);
      }
    }

    // Phase 3: re-read every touched path and verify bytes and existence.
    const drift: StateMismatch[] = [];
    for (const [path, expected] of overlay) {
      const actual = this.snapshot(path);
      if (actual !== expected) {
        drift.push({ entryId: -1, path, expected, actual });
      }
    }
    if (drift.length > 0) {
      throw new IntegrityError(drift);
    }

    // Phase 4: move the batch to the opposite stack.
    source.length -= count;
    const target = direction === 'undo' ? this.redoStack : this.undoStack;
    target.push(...batch);

    return {
      direction,
      entries: batch,
      verified: [...overlay].map(([path, digest]) => ({ path, digest })),
    };
  }

  private executeInverse(entry: Entry): void {
    switch (entry.kind) {
      case 'create':
        unlinkSync(entry.path);
        break;
      case 'write':
        writeFileSync(entry.path, this.store.get(entry.before));
        break;
      case 'delete':
        ensureParent(entry.path);
        writeFileSync(entry.path, this.store.get(entry.before));
        break;
      case 'move':
        renameSync(entry.to, entry.from);
        if (entry.overwritten !== null) {
          writeFileSync(entry.to, this.store.get(entry.overwritten));
        }
        break;
    }
  }

  private executeForward(entry: Entry): void {
    switch (entry.kind) {
      case 'create':
        ensureParent(entry.path);
        writeFileSync(entry.path, this.store.get(entry.after));
        break;
      case 'write':
        writeFileSync(entry.path, this.store.get(entry.after));
        break;
      case 'delete':
        unlinkSync(entry.path);
        break;
      case 'move':
        renameSync(entry.from, entry.to);
        break;
    }
  }
}
