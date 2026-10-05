import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { FileUndoManager } from "../src/file-undo.ts";

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

interface Sandbox {
  root: string;
  mgr: FileUndoManager;
  p: (name: string) => string;
  cleanup: () => void;
}

function makeSandbox(): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "file-undo-"));
  const mgr = new FileUndoManager(path.join(root, ".undo-store"));
  return {
    root,
    mgr,
    p: (name) => path.join(root, name),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test("create -> undo removes file; redo restores exact bytes", () => {
  const { mgr, p, cleanup } = makeSandbox();
  try {
    const content = Buffer.from("hello editor\n", "utf8");
    mgr.writeFile(p("a.txt"), content);
    assert.equal(fs.readFileSync(p("a.txt"), "utf8"), "hello editor\n");

    const undone = mgr.undo();
    assert.equal(undone.ok, true);
    assert.equal(undone.verified, true);
    assert.equal(fs.existsSync(p("a.txt")), false);

    const redone = mgr.redo();
    assert.equal(redone.ok, true);
    assert.equal(redone.verified, true);
    assert.equal(sha256(fs.readFileSync(p("a.txt"))), sha256(content));
  } finally {
    cleanup();
  }
});

test("overwrite keeps a backup of the target; undo restores old bytes", () => {
  const { mgr, p, cleanup } = makeSandbox();
  try {
    mgr.writeFile(p("b.txt"), "version-1");
    mgr.writeFile(p("b.txt"), "version-2");
    assert.equal(fs.readFileSync(p("b.txt"), "utf8"), "version-2");

    const r = mgr.undo();
    assert.equal(r.ok, true);
    assert.equal(r.verified, true);
    assert.equal(fs.readFileSync(p("b.txt"), "utf8"), "version-1");

    const r2 = mgr.undo();
    assert.equal(r2.ok, true);
    assert.equal(fs.existsSync(p("b.txt")), false);
  } finally {
    cleanup();
  }
});

test("delete -> undo restores the deleted bytes", () => {
  const { mgr, p, cleanup } = makeSandbox();
  try {
    mgr.writeFile(p("c.txt"), "precious bytes");
    mgr.deleteFile(p("c.txt"));
    assert.equal(fs.existsSync(p("c.txt")), false);

    const r = mgr.undo();
    assert.equal(r.ok, true);
    assert.equal(r.verified, true);
    assert.equal(fs.readFileSync(p("c.txt"), "utf8"), "precious bytes");
  } finally {
    cleanup();
  }
});

test("move chain a->b->c unwinds as an atomic batch and replays", () => {
  const { mgr, p, cleanup } = makeSandbox();
  try {
    mgr.writeFile(p("a.txt"), "chain-bytes");
    mgr.moveFile(p("a.txt"), p("b.txt"));
    mgr.moveFile(p("b.txt"), p("c.txt"));
    assert.equal(fs.readFileSync(p("c.txt"), "utf8"), "chain-bytes");

    // inverse replay of the whole chain in one atomic batch
    const undone = mgr.undoBatch(2);
    assert.equal(undone.ok, true);
    assert.equal(undone.applied, 2);
    assert.equal(undone.verified, true);
    assert.equal(fs.readFileSync(p("a.txt"), "utf8"), "chain-bytes");
    assert.equal(fs.existsSync(p("b.txt")), false);
    assert.equal(fs.existsSync(p("c.txt")), false);

    // replay the chain again, bytes and paths re-verified
    const redone = mgr.redoBatch(2);
    assert.equal(redone.ok, true);
    assert.equal(redone.applied, 2);
    assert.equal(redone.verified, true);
    assert.equal(fs.existsSync(p("a.txt")), false);
    assert.equal(fs.existsSync(p("b.txt")), false);
    assert.equal(fs.readFileSync(p("c.txt"), "utf8"), "chain-bytes");
  } finally {
    cleanup();
  }
});

test("move onto an existing file backs it up; undo restores both", () => {
  const { mgr, p, cleanup } = makeSandbox();
  try {
    mgr.writeFile(p("src.txt"), "incoming");
    mgr.writeFile(p("dst.txt"), "original-dst");
    mgr.moveFile(p("src.txt"), p("dst.txt"));
    assert.equal(fs.readFileSync(p("dst.txt"), "utf8"), "incoming");

    const r = mgr.undo();
    assert.equal(r.ok, true);
    assert.equal(r.verified, true);
    assert.equal(fs.readFileSync(p("src.txt"), "utf8"), "incoming");
    assert.equal(fs.readFileSync(p("dst.txt"), "utf8"), "original-dst");
  } finally {
    cleanup();
  }
});

test("undo refuses when the after-image no longer matches (external edit)", () => {
  const { mgr, p, cleanup } = makeSandbox();
  try {
    mgr.writeFile(p("d.txt"), "tracked");
    fs.writeFileSync(p("d.txt"), "edited outside the editor"); // external change

    const r = mgr.undo();
    assert.equal(r.ok, false);
    assert.equal(r.applied, 0);
    assert.equal(r.failures.length, 1);
    assert.equal(r.failures[0]!.reason, "external-modification");
    // file left untouched
    assert.equal(fs.readFileSync(p("d.txt"), "utf8"), "edited outside the editor");
  } finally {
    cleanup();
  }
});

test("batch undo is all-or-nothing: one external edit blocks the whole batch", () => {
  const { mgr, p, cleanup } = makeSandbox();
  try {
    mgr.writeFile(p("e1.txt"), "one");
    mgr.writeFile(p("e2.txt"), "two");
    mgr.writeFile(p("e3.txt"), "three");
    // external modification of a single file in the batch
    fs.appendFileSync(p("e2.txt"), "-tampered");

    const r = mgr.undoBatch(3);
    assert.equal(r.ok, false);
    assert.equal(r.applied, 0);
    assert.equal(r.failures.length, 1);
    assert.equal(r.failures[0]!.path, p("e2.txt"));

    // nothing in the batch was applied: every file keeps its current bytes
    assert.equal(fs.readFileSync(p("e1.txt"), "utf8"), "one");
    assert.equal(fs.readFileSync(p("e2.txt"), "utf8"), "two-tampered");
    assert.equal(fs.readFileSync(p("e3.txt"), "utf8"), "three");
    assert.equal(mgr.pendingUndo, 3); // history preserved for a later retry
  } finally {
    cleanup();
  }
});

test("batch undo of a move chain detects tampering at any link", () => {
  const { mgr, p, cleanup } = makeSandbox();
  try {
    mgr.writeFile(p("m.txt"), "payload");
    mgr.moveFile(p("m.txt"), p("m2.txt"));
    mgr.moveFile(p("m2.txt"), p("m3.txt"));
    fs.writeFileSync(p("m3.txt"), "payload-corrupted"); // external edit at chain tail

    const r = mgr.undoBatch(2);
    assert.equal(r.ok, false);
    assert.equal(r.applied, 0);
    assert.equal(fs.readFileSync(p("m3.txt"), "utf8"), "payload-corrupted");
    assert.equal(fs.existsSync(p("m.txt")), false);
    assert.equal(fs.existsSync(p("m2.txt")), false);
  } finally {
    cleanup();
  }
});

test("undo detects a missing file and an unexpected file", () => {
  const { mgr, p, cleanup } = makeSandbox();
  try {
    mgr.writeFile(p("gone.txt"), "x");
    fs.rmSync(p("gone.txt")); // externally deleted
    const r1 = mgr.undo();
    assert.equal(r1.ok, false);
    assert.equal(r1.failures[0]!.reason, "missing");

    const mgr2 = new FileUndoManager(p(".store2"));
    mgr2.deleteFile(p("gone.txt")); // no-op delete recorded? file absent -> skip
    mgr2.writeFile(p("f.txt"), "y");
    mgr2.deleteFile(p("f.txt"));
    fs.writeFileSync(p("f.txt"), "recreated externally"); // unexpected file
    const r2 = mgr2.undo();
    assert.equal(r2.ok, false);
    assert.equal(r2.failures[0]!.reason, "unexpected-file");
  } finally {
    cleanup();
  }
});

test("a new operation clears the redo stack", () => {
  const { mgr, p, cleanup } = makeSandbox();
  try {
    mgr.writeFile(p("g.txt"), "v1");
    mgr.undo();
    assert.equal(mgr.pendingRedo, 1);
    mgr.writeFile(p("h.txt"), "other");
    assert.equal(mgr.pendingRedo, 0);
    const r = mgr.redo();
    assert.equal(r.ok, false);
    assert.equal(r.applied, 0);
  } finally {
    cleanup();
  }
});

test("binary content round-trips byte-exact through undo/redo", () => {
  const { mgr, p, cleanup } = makeSandbox();
  try {
    const bytes = Buffer.alloc(4096);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) % 256;
    mgr.writeFile(p("bin.dat"), bytes);
    mgr.writeFile(p("bin.dat"), Buffer.from("shorter"));

    const u = mgr.undo();
    assert.equal(u.ok, true);
    assert.equal(u.verified, true);
    assert.equal(sha256(fs.readFileSync(p("bin.dat"))), sha256(bytes));

    const r = mgr.redo();
    assert.equal(r.ok, true);
    assert.equal(r.verified, true);
    assert.equal(fs.readFileSync(p("bin.dat"), "utf8"), "shorter");
  } finally {
    cleanup();
  }
});

test("full history: undo everything then redo everything, verified", () => {
  const { mgr, p, cleanup } = makeSandbox();
  try {
    mgr.writeFile(p("h1.txt"), "alpha");
    mgr.writeFile(p("h2.txt"), "beta");
    mgr.moveFile(p("h2.txt"), p("h2-renamed.txt"));
    mgr.deleteFile(p("h1.txt"));

    const u = mgr.undoBatch(4);
    assert.equal(u.ok, true);
    assert.equal(u.applied, 4);
    assert.equal(u.verified, true);
    assert.equal(fs.existsSync(p("h1.txt")), false);
    assert.equal(fs.existsSync(p("h2.txt")), false);
    assert.equal(fs.existsSync(p("h2-renamed.txt")), false);

    const r = mgr.redoBatch(4);
    assert.equal(r.ok, true);
    assert.equal(r.applied, 4);
    assert.equal(r.verified, true);
    assert.equal(fs.existsSync(p("h1.txt")), false);
    assert.equal(fs.readFileSync(p("h2-renamed.txt"), "utf8"), "beta");
  } finally {
    cleanup();
  }
});
