import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  digestBytes,
  ExternalModificationError,
  UndoManager,
  type CreateEntry,
  type DeleteEntry,
  type MoveEntry,
  type WriteEntry,
} from '../src/index.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'editor-undo-'));
}

function read(path: string): string {
  return new TextDecoder().decode(readFileSync(path));
}

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

test('records before/after digests for every operation', () => {
  const dir = tempDir();
  try {
    const um = new UndoManager();
    const a = join(dir, 'a.txt');
    const b = join(dir, 'b.txt');

    const e1 = um.writeFile(a, 'v1') as CreateEntry;
    assert.equal(e1.kind, 'create');
    assert.equal(e1.after, digestBytes(bytes('v1')));

    const e2 = um.writeFile(a, 'v2') as WriteEntry;
    assert.equal(e2.kind, 'write');
    assert.equal(e2.before, digestBytes(bytes('v1')));
    assert.equal(e2.after, digestBytes(bytes('v2')));

    const e3 = um.moveFile(a, b) as MoveEntry;
    assert.equal(e3.kind, 'move');
    assert.equal(e3.before, digestBytes(bytes('v2')));
    assert.equal(e3.after, digestBytes(bytes('v2')));
    assert.equal(e3.overwritten, null);

    const e4 = um.deleteFile(b) as DeleteEntry;
    assert.equal(e4.kind, 'delete');
    assert.equal(e4.before, digestBytes(bytes('v2')));

    assert.deepEqual(um.journal.map((e) => e.id), [e1.id, e2.id, e3.id, e4.id]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('undo restores bytes and paths, redo replays them, both verified', () => {
  const dir = tempDir();
  try {
    const um = new UndoManager();
    const a = join(dir, 'a.txt');

    um.writeFile(a, 'v1');
    um.writeFile(a, 'v2');

    const undoneWrite = um.undo();
    assert.equal(read(a), 'v1');
    assert.equal(
      undoneWrite.verified.find((v) => v.path === a)?.digest,
      digestBytes(bytes('v1')),
    );

    um.undo();
    assert.equal(existsSync(a), false);

    const redoneCreate = um.redo();
    assert.equal(read(a), 'v1');
    assert.equal(
      redoneCreate.verified.find((v) => v.path === a)?.digest,
      digestBytes(bytes('v1')),
    );

    um.redo();
    assert.equal(read(a), 'v2');
    assert.equal(um.pendingUndo, 2);
    assert.equal(um.pendingRedo, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('undo only accepts the current after-image', () => {
  const dir = tempDir();
  try {
    const um = new UndoManager();
    const a = join(dir, 'a.txt');
    um.writeFile(a, 'v1');

    writeFileSync(a, 'tampered'); // external modification

    assert.throws(() => um.undo(), ExternalModificationError);
    assert.equal(read(a), 'tampered'); // untouched
    assert.equal(um.pendingUndo, 1); // entry still on the undo stack
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('batch undo is all-or-nothing when any path was externally modified', () => {
  const dir = tempDir();
  try {
    const um = new UndoManager();
    const a = join(dir, 'a.txt');
    const b = join(dir, 'b.txt');
    const c = join(dir, 'c.txt');
    um.writeFile(a, '1');
    um.writeFile(b, '2');
    um.writeFile(c, '3');

    writeFileSync(b, 'tampered'); // external modification of one entry's after-image

    let caught: unknown;
    try {
      um.undo(3);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof ExternalModificationError);
    assert.equal(caught.mismatches.length, 1);
    assert.equal(caught.mismatches[0]?.path, b);

    // Nothing in the batch was applied.
    assert.equal(read(a), '1');
    assert.equal(read(b), 'tampered');
    assert.equal(read(c), '3');
    assert.equal(um.pendingUndo, 3);
    assert.equal(um.pendingRedo, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('move chains revert link by link and replay forward again', () => {
  const dir = tempDir();
  try {
    const um = new UndoManager();
    const a = join(dir, 'a.txt');
    const b = join(dir, 'b.txt');
    const c = join(dir, 'c.txt');
    um.writeFile(a, 'x');
    um.moveFile(a, b);
    um.moveFile(b, c);
    assert.equal(read(c), 'x');

    const undone = um.undo(2); // both moves as one batch
    assert.equal(read(a), 'x');
    assert.equal(existsSync(b), false);
    assert.equal(existsSync(c), false);
    const verified = new Map(undone.verified.map((v) => [v.path, v.digest]));
    assert.equal(verified.get(a), digestBytes(bytes('x')));
    assert.equal(verified.get(b), null);
    assert.equal(verified.get(c), null);

    um.redo(2);
    assert.equal(existsSync(a), false);
    assert.equal(existsSync(b), false);
    assert.equal(read(c), 'x');

    // Also works one link at a time.
    um.undo();
    assert.equal(read(b), 'x');
    assert.equal(existsSync(c), false);
    um.undo();
    assert.equal(read(a), 'x');
    assert.equal(existsSync(b), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('overwritten move targets are backed up and restored on undo', () => {
  const dir = tempDir();
  try {
    const um = new UndoManager();
    const a = join(dir, 'a.txt');
    const b = join(dir, 'b.txt');
    um.writeFile(a, 'aaa');
    um.writeFile(b, 'bbb');
    const move = um.moveFile(a, b) as MoveEntry;
    assert.equal(move.overwritten, digestBytes(bytes('bbb')));
    assert.equal(read(b), 'aaa');
    assert.equal(existsSync(a), false);

    um.undo();
    assert.equal(read(a), 'aaa');
    assert.equal(read(b), 'bbb'); // victim restored from backup

    um.redo();
    assert.equal(existsSync(a), false);
    assert.equal(read(b), 'aaa');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('redo rejects when a restored overwrite victim was externally modified', () => {
  const dir = tempDir();
  try {
    const um = new UndoManager();
    const a = join(dir, 'a.txt');
    const b = join(dir, 'b.txt');
    um.writeFile(a, 'aaa');
    um.writeFile(b, 'bbb');
    um.moveFile(a, b);
    um.undo(); // restores a='aaa', b='bbb'

    writeFileSync(b, 'tampered'); // clobber the restored victim

    assert.throws(() => um.redo(), ExternalModificationError);
    assert.equal(read(a), 'aaa');
    assert.equal(read(b), 'tampered');
    assert.equal(um.pendingRedo, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('delete undo restores bytes; an externally recreated file blocks it', () => {
  const dir = tempDir();
  try {
    const um = new UndoManager();
    const f = join(dir, 'f.txt');
    um.writeFile(f, 'data');
    um.deleteFile(f);
    assert.equal(existsSync(f), false);

    um.undo();
    assert.equal(read(f), 'data');

    um.deleteFile(f);
    writeFileSync(f, 'other'); // external recreate; after-image of delete is "absent"
    assert.throws(() => um.undo(), ExternalModificationError);
    assert.equal(read(f), 'other');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a new operation clears the redo stack', () => {
  const dir = tempDir();
  try {
    const um = new UndoManager();
    const a = join(dir, 'a.txt');
    um.writeFile(a, '1');
    um.writeFile(a, '2');
    um.undo();
    assert.equal(um.pendingRedo, 1);

    um.writeFile(a, '3');
    assert.equal(um.pendingRedo, 0);
    assert.equal(um.pendingUndo, 2);
    assert.throws(() => um.redo(), RangeError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('batch undo of mixed operations verifies every byte and path afterwards', () => {
  const dir = tempDir();
  try {
    const um = new UndoManager();
    const keep = join(dir, 'keep.txt');
    const gone = join(dir, 'gone.txt');
    const movedFrom = join(dir, 'from.txt');
    const movedTo = join(dir, 'to.txt');

    um.writeFile(keep, 'keep-v1');
    um.writeFile(gone, 'gone-v1');
    um.writeFile(movedFrom, 'moved-v1');
    um.writeFile(keep, 'keep-v2');
    um.deleteFile(gone);
    um.moveFile(movedFrom, movedTo);
    assert.equal(um.pendingUndo, 6);

    const result = um.undo(6); // inverse-replay everything
    assert.equal(existsSync(keep), false);
    assert.equal(existsSync(gone), false);
    assert.equal(existsSync(movedFrom), false);
    assert.equal(existsSync(movedTo), false);
    for (const v of result.verified) {
      assert.equal(v.digest, null, `${v.path} should be absent`);
    }

    const replayed = um.redo(6); // replay everything
    assert.equal(read(keep), 'keep-v2');
    assert.equal(existsSync(gone), false);
    assert.equal(existsSync(movedFrom), false);
    assert.equal(read(movedTo), 'moved-v1');
    const verified = new Map(replayed.verified.map((v) => [v.path, v.digest]));
    assert.equal(verified.get(keep), digestBytes(bytes('keep-v2')));
    assert.equal(verified.get(gone), null);
    assert.equal(verified.get(movedFrom), null);
    assert.equal(verified.get(movedTo), digestBytes(bytes('moved-v1')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
