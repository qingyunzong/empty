/**
 * file-undo: an editor-style undo library for file operations.
 *
 * Design:
 * - Every operation records a before/after snapshot ("摘要") of each path it
 *   touches: existence + sha256 digest, with the exact bytes backed up in a
 *   private store directory.
 * - Undo only accepts the current after-image: if the on-disk state no longer
 *   matches the recorded after-state, the file was modified externally and
 *   the undo is refused.
 * - Batch undo is atomic: the whole batch is validated (in reverse order,
 *   against a simulated state map so move chains check out) before anything
 *   is applied. Any external modification makes the entire batch a no-op.
 * - Moves are first-class entries, so chains (a->b, b->c) unwind correctly,
 *   and writing/moving onto an existing path keeps a backup of the
 *   overwritten target.
 * - After replay (redo) and inverse replay (undo), bytes and paths are
 *   re-verified against the recorded digests.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface PathState {
  exists: boolean;
  /** sha256 hex digest of the file bytes, null when absent. */
  hash: string | null;
  /** backup file inside the store holding the exact bytes, null when absent. */
  backup: string | null;
}

export interface OpEntry {
  path: string;
  before: PathState;
  after: PathState;
}

export type OpKind = "create" | "write" | "delete" | "move";

export interface Operation {
  id: number;
  kind: OpKind;
  entries: OpEntry[];
}

export interface CheckFailure {
  path: string;
  reason: "external-modification" | "missing" | "unexpected-file";
  expectedHash: string | null;
  actualHash: string | null;
}

export interface BatchResult {
  ok: boolean;
  /** number of operations actually undone/redone (0 when rejected). */
  applied: number;
  /** external modifications detected during pre-validation. */
  failures: CheckFailure[];
  /** post-apply verification of bytes and paths passed. */
  verified: boolean;
}

interface LiveState {
  exists: boolean;
  hash: string | null;
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function readLive(p: string): LiveState {
  let st: { isFile(): boolean };
  try {
    st = fs.lstatSync(p);
  } catch {
    return { exists: false, hash: null };
  }
  if (!st.isFile()) return { exists: false, hash: null };
  return { exists: true, hash: sha256(fs.readFileSync(p)) };
}

function sameState(live: LiveState, snap: PathState): boolean {
  return live.exists === snap.exists && live.hash === snap.hash;
}

function classify(pathname: string, expected: PathState, actual: LiveState): CheckFailure {
  let reason: CheckFailure["reason"] = "external-modification";
  if (expected.exists && !actual.exists) reason = "missing";
  else if (!expected.exists && actual.exists) reason = "unexpected-file";
  return { path: pathname, reason, expectedHash: expected.hash, actualHash: actual.hash };
}

export class FileUndoManager {
  #storeDir: string;
  #seq = 0;
  #undoStack: Operation[] = [];
  #redoStack: Operation[] = [];

  constructor(storeDir: string) {
    this.#storeDir = path.resolve(storeDir);
    fs.mkdirSync(this.#storeDir, { recursive: true });
  }

  get pendingUndo(): number {
    return this.#undoStack.length;
  }

  get pendingRedo(): number {
    return this.#redoStack.length;
  }

  /** Capture the current state of `p`, backing up exact bytes when present. */
  #capture(p: string): PathState {
    const live = readLive(p);
    if (!live.exists) return { exists: false, hash: null, backup: null };
    const backup = path.join(
      this.#storeDir,
      `${String(++this.#seq).padStart(6, "0")}-${live.hash!.slice(0, 16)}.bak`,
    );
    fs.copyFileSync(p, backup);
    return { exists: true, hash: live.hash, backup };
  }

  #push(kind: OpKind, entries: OpEntry[]): Operation {
    const op: Operation = { id: ++this.#seq, kind, entries };
    this.#undoStack.push(op);
    this.#redoStack.length = 0; // a new operation invalidates redo history
    return op;
  }

  /** Create (or overwrite) a file, recording before/after snapshots. */
  writeFile(filePath: string, content: Buffer | string): Operation {
    const p = path.resolve(filePath);
    const before = this.#capture(p); // overwrite target backup, if any
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    const after = this.#capture(p);
    return this.#push(before.exists ? "write" : "create", [{ path: p, before, after }]);
  }

  /** Delete a file, keeping a backup of its bytes. */
  deleteFile(filePath: string): Operation {
    const p = path.resolve(filePath);
    const before = this.#capture(p);
    if (before.exists) fs.rmSync(p);
    const after = this.#capture(p);
    return this.#push("delete", [{ path: p, before, after }]);
  }

  /** Move src -> dest. An existing dest is backed up so undo restores it. */
  moveFile(src: string, dest: string): Operation {
    const s = path.resolve(src);
    const d = path.resolve(dest);
    if (s === d) throw new Error("moveFile: src and dest are identical");
    const srcBefore = this.#capture(s);
    const destBefore = this.#capture(d); // overwrite target backup, if any
    fs.mkdirSync(path.dirname(d), { recursive: true });
    fs.renameSync(s, d);
    const srcAfter = this.#capture(s);
    const destAfter = this.#capture(d);
    return this.#push("move", [
      { path: s, before: srcBefore, after: srcAfter },
      { path: d, before: destBefore, after: destAfter },
    ]);
  }

  /** Restore `p` to the given snapshot state (exact bytes or absence). */
  #restore(p: string, state: PathState): void {
    if (state.exists) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.copyFileSync(state.backup!, p);
    } else if (readLive(p).exists) {
      fs.rmSync(p);
    }
  }

  /**
   * Validate a batch of operations against the (simulated) current state.
   * `ops` must be given in processing order (undo: newest first; redo:
   * oldest first).
   * `direction` selects which side must match the live state and which side
   * the batch would move towards. Nothing is written here.
   */
  #validate(
    ops: Operation[],
    from: (e: OpEntry) => PathState,
    to: (e: OpEntry) => PathState,
  ): CheckFailure[] {
    const simulated = new Map<string, LiveState>();
    const liveOf = (p: string): LiveState => {
      let s = simulated.get(p);
      if (!s) {
        s = readLive(p);
        simulated.set(p, s);
      }
      return s;
    };
    const failures: CheckFailure[] = [];
    // each op must see exactly the state its predecessor left
    for (const op of ops) {
      for (const entry of op.entries) {
        const cur = liveOf(entry.path);
        if (!sameState(cur, from(entry))) {
          failures.push(classify(entry.path, from(entry), cur));
        }
      }
      // advance the simulation towards the batch's target state
      for (const entry of op.entries) {
        const t = to(entry);
        simulated.set(entry.path, { exists: t.exists, hash: t.hash });
      }
    }
    return failures;
  }

  /** Apply a validated batch in processing order, then verify bytes/paths. */
  #apply(ops: Operation[], to: (e: OpEntry) => PathState): boolean {
    // later writes win, so the expected final state of a path comes from
    // the last op that touches it (move chains rewrite the same path)
    const expected = new Map<string, PathState>();
    for (const op of ops) {
      for (const entry of op.entries) {
        this.#restore(entry.path, to(entry));
        expected.set(entry.path, to(entry));
      }
    }
    // post-check: every touched path must now match its final snapshot
    for (const [p, state] of expected) {
      if (!sameState(readLive(p), state)) return false;
    }
    return true;
  }

  /**
   * Atomically undo the newest `count` operations. The whole batch is
   * checked first; any external modification leaves every file untouched.
   */
  undoBatch(count: number): BatchResult {
    const n = Math.max(0, Math.min(count, this.#undoStack.length));
    if (n === 0) return { ok: false, applied: 0, failures: [], verified: false };
    const batch = this.#undoStack.slice(-n);
    const order = [...batch].reverse(); // unwind newest first
    const failures = this.#validate(order, (e) => e.after, (e) => e.before);
    if (failures.length > 0) return { ok: false, applied: 0, failures, verified: false };
    const verified = this.#apply(order, (e) => e.before);
    const done = this.#undoStack.splice(this.#undoStack.length - n, n);
    // redo replays oldest first, so the oldest undone op sits on top
    for (const op of [...done].reverse()) this.#redoStack.push(op);
    return { ok: true, applied: n, failures: [], verified };
  }

  /** Undo the single newest operation. */
  undo(): BatchResult {
    return this.undoBatch(1);
  }

  /**
   * Atomically redo (replay) the newest `count` undone operations, then
   * verify bytes and paths against the recorded after-images.
   */
  redoBatch(count: number): BatchResult {
    const n = Math.max(0, Math.min(count, this.#redoStack.length));
    if (n === 0) return { ok: false, applied: 0, failures: [], verified: false };
    const batch = this.#redoStack.slice(-n).reverse(); // replay oldest first
    const failures = this.#validate(batch, (e) => e.before, (e) => e.after);
    if (failures.length > 0) return { ok: false, applied: 0, failures, verified: false };
    const verified = this.#apply(batch, (e) => e.after);
    const done = this.#redoStack.splice(this.#redoStack.length - n, n);
    this.#undoStack.push(...done.reverse()); // restore newest-on-top order
    return { ok: true, applied: n, failures: [], verified };
  }

  /** Redo the single most recently undone operation. */
  redo(): BatchResult {
    return this.redoBatch(1);
  }
}
