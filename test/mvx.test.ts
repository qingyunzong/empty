import { test } from "node:test";
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const CLI = path.join(__dirname, "..", "src", "mvx.js");
const JOURNAL_NAME = ".mvx-journal.json";

function setup(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mvx-test-"));
  for (const [name, content] of Object.entries(files)) {
    if (content.startsWith("link:")) {
      fs.symlinkSync(content.slice(5), path.join(dir, name));
    } else {
      fs.writeFileSync(path.join(dir, name), content);
    }
  }
  return dir;
}

// Snapshot of a directory: name -> "file:<content>" | "link:<target>".
// Journal and staging files are skipped. Uses lstat only.
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of fs.readdirSync(dir).sort()) {
    if (name.startsWith(".mvx")) continue;
    const p = path.join(dir, name);
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) {
      out[name] = "link:" + fs.readlinkSync(p);
    } else if (st.isDirectory()) {
      out[name] = "dir";
    } else {
      out[name] = "file:" + fs.readFileSync(p, "utf8");
    }
  }
  return out;
}

function leftovers(dir: string): string[] {
  return fs.readdirSync(dir).filter((n) => n.startsWith(".mvx"));
}

function run(
  dir: string,
  args: string[],
  env: Record<string, string> = {}
): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(process.execPath, [CLI, "--dir", dir, ...args], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

test("simple rename", () => {
  const dir = setup({ a: "A", b: "B" });
  const r = run(dir, ["a=c"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(snapshot(dir), { b: "file:B", c: "file:A" });
  assert.deepEqual(leftovers(dir), []);
});

test("swap two files", () => {
  const dir = setup({ a: "A", b: "B" });
  const r = run(dir, ["a=b", "b=a"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(snapshot(dir), { a: "file:B", b: "file:A" });
});

test("cycle of three", () => {
  const dir = setup({ a: "A", b: "B", c: "C" });
  const r = run(dir, ["a=b", "b=c", "c=a"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(snapshot(dir), { a: "file:C", b: "file:A", c: "file:B" });
});

test("rename into a subdirectory", () => {
  const dir = setup({ a: "A" });
  fs.mkdirSync(path.join(dir, "sub"));
  const r = run(dir, ["a=sub/b"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(dir, "sub", "b"), "utf8"), "A");
  assert.deepEqual(snapshot(dir), { sub: "dir" });
});

test("external destination conflict aborts before any change", () => {
  const dir = setup({ a: "A", b: "B" });
  const r = run(dir, ["a=b"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /external conflict/);
  assert.deepEqual(snapshot(dir), { a: "file:A", b: "file:B" });
  assert.deepEqual(leftovers(dir), []);
});

test("missing source aborts", () => {
  const dir = setup({ a: "A" });
  const r = run(dir, ["nope=x"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /does not exist/);
  assert.deepEqual(snapshot(dir), { a: "file:A" });
});

test("duplicate destination aborts", () => {
  const dir = setup({ a: "A", b: "B" });
  const r = run(dir, ["a=c", "b=c"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /duplicate destination/);
  assert.deepEqual(snapshot(dir), { a: "file:A", b: "file:B" });
});

test("identical source and destination aborts", () => {
  const dir = setup({ a: "A" });
  const r = run(dir, ["a=a"]);
  assert.equal(r.status, 1);
  assert.deepEqual(snapshot(dir), { a: "file:A" });
});

test("symlinks are renamed as-is and never followed", () => {
  // Swap a symlink with a regular file. If mvx followed the link, the
  // target's content would end up at the wrong place or the link would
  // be dereferenced.
  const dir = setup({ real: "REAL", link: "link:real" });
  const r = run(dir, ["link=real", "real=link"]);
  assert.equal(r.status, 0, r.stderr);
  // "real" now holds what "link" was: a symlink (its stored target text
  // is unchanged, so it points at the name "real" -> itself is fine to
  // verify via readlink only).
  const realSt = fs.lstatSync(path.join(dir, "real"));
  assert.ok(realSt.isSymbolicLink());
  assert.equal(fs.readlinkSync(path.join(dir, "real")), "real");
  // "link" now holds the regular file content.
  const linkSt = fs.lstatSync(path.join(dir, "link"));
  assert.ok(linkSt.isFile());
  assert.equal(fs.readFileSync(path.join(dir, "link"), "utf8"), "REAL");
});

test("renaming a symlink does not touch its target", () => {
  const dir = setup({ target: "T", link: "link:target" });
  const r = run(dir, ["link=link2"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(snapshot(dir), { target: "file:T", link2: "link:target" });
});

test("crash during staging recovers to the intended batch", () => {
  const dir = setup({ a: "A", b: "B", c: "C" });
  const crashed = run(dir, ["a=b", "b=c", "c=a"], { MVX_FAIL_STAGING: "1" });
  assert.equal(crashed.status, 75);
  assert.ok(fs.existsSync(path.join(dir, JOURNAL_NAME)));
  // Nothing renamed yet.
  assert.deepEqual(snapshot(dir), { a: "file:A", b: "file:B", c: "file:C" });
  const rec = run(dir, ["--recover"]);
  assert.equal(rec.status, 0, rec.stderr);
  assert.deepEqual(snapshot(dir), { a: "file:C", b: "file:A", c: "file:B" });
  assert.deepEqual(leftovers(dir), []);
});

test("fault injection at every rename step: no loss after recovery", () => {
  // A 3-cycle performs 6 renames (3 to staging, 3 to final). Crash after
  // each possible rename, then recover and verify the exact final state.
  const expected = { a: "file:C", b: "file:A", c: "file:B" };
  for (let k = 1; k <= 6; k++) {
    const dir = setup({ a: "A", b: "B", c: "C" });
    const crashed = run(dir, ["a=b", "b=c", "c=a"], { MVX_FAIL_AT: String(k) });
    assert.equal(crashed.status, 75, `k=${k}: ${crashed.stderr}`);
    assert.ok(fs.existsSync(path.join(dir, JOURNAL_NAME)), `k=${k}: journal kept`);
    // No entry is ever lost: the three contents A, B, C must all be
    // present somewhere (original names and/or staging names).
    const contents = fs
      .readdirSync(dir)
      .filter((n) => !n.startsWith(".mvx-journal"))
      .map((n) => fs.readFileSync(path.join(dir, n), "utf8"))
      .sort();
    assert.deepEqual(contents, ["A", "B", "C"], `k=${k}: data loss detected`);
    const rec = run(dir, ["--recover"]);
    assert.equal(rec.status, 0, `k=${k}: ${rec.stderr}`);
    assert.deepEqual(snapshot(dir), expected, `k=${k}`);
    assert.deepEqual(leftovers(dir), [], `k=${k}: staging files left behind`);
  }
});

test("external rename during downtime stops recovery without loss", () => {
  const dir = setup({ a: "A", b: "B", c: "C" });
  // Crash after all sources are staged but before any final rename, so
  // "b" is still a pending destination.
  const crashed = run(dir, ["a=b", "b=c", "c=a"], { MVX_FAIL_AT: "3" });
  assert.equal(crashed.status, 75);
  // While the batch is interrupted, someone else creates "b" externally.
  fs.writeFileSync(path.join(dir, "b"), "EXTERNAL");
  const rec = run(dir, ["--recover"]);
  assert.equal(rec.status, 2);
  assert.match(rec.stderr, /external conflict/);
  // Journal retained, external file untouched, batch data still present.
  assert.ok(fs.existsSync(path.join(dir, JOURNAL_NAME)));
  const contents = fs
    .readdirSync(dir)
    .filter((n) => !n.startsWith(".mvx-journal"))
    .map((n) => fs.readFileSync(path.join(dir, n), "utf8"))
    .sort();
  assert.deepEqual(contents, ["A", "B", "C", "EXTERNAL"]);
  // Remove the intruder: recovery completes the original intent.
  fs.unlinkSync(path.join(dir, "b"));
  const rec2 = run(dir, ["--recover"]);
  assert.equal(rec2.status, 0, rec2.stderr);
  assert.deepEqual(snapshot(dir), { a: "file:C", b: "file:A", c: "file:B" });
  assert.deepEqual(leftovers(dir), []);
});

test("new batch is refused while a previous batch is pending", () => {
  const dir = setup({ a: "A", b: "B" });
  const crashed = run(dir, ["a=b", "b=a"], { MVX_FAIL_AT: "1" });
  assert.equal(crashed.status, 75);
  const r = run(dir, ["a=z"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--recover/);
  const rec = run(dir, ["--recover"]);
  assert.equal(rec.status, 0, rec.stderr);
  assert.deepEqual(snapshot(dir), { a: "file:B", b: "file:A" });
});

test("recover without a pending batch fails cleanly", () => {
  const dir = setup({ a: "A" });
  const r = run(dir, ["--recover"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no pending batch/);
});

test("source replaced externally during downtime stops recovery", () => {
  const dir = setup({ a: "A", b: "B" });
  const crashed = run(dir, ["a=b", "b=a"], { MVX_FAIL_STAGING: "1" });
  assert.equal(crashed.status, 75);
  // Replace source "a" with a different file (different inode).
  fs.unlinkSync(path.join(dir, "a"));
  fs.writeFileSync(path.join(dir, "a"), "IMPOSTOR");
  const rec = run(dir, ["--recover"]);
  assert.equal(rec.status, 2);
  assert.match(rec.stderr, /replaced externally|missing/);
  assert.ok(fs.existsSync(path.join(dir, JOURNAL_NAME)));
});
