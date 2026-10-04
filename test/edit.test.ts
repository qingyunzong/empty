import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEdits, type EditSuccess } from "../src/edit.js";
import { expand } from "../src/expand.js";
import { decode } from "../src/quote.js";

function vfs(entries: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(entries));
}

function ok(result: ReturnType<typeof applyEdits>): EditSuccess {
  assert.ok(result.ok, "edit should succeed");
  return result;
}

test("reverse edit rewrites the originating source file", () => {
  const files = vfs({
    "main.rsp": "cc @flags.rsp -o out",
    "flags.rsp": "-Wall -O2",
  });
  // args: cc -Wall -O2 -o out ; replace -O2 (index 2) with -O3.
  const result = ok(applyEdits("main.rsp", files, new Set(), [{ index: 2, value: "-O3" }]));
  assert.equal(result.files.get("flags.rsp"), "-Wall -O3");
  assert.equal(result.files.get("main.rsp"), "cc @flags.rsp -o out");
  assert.deepEqual(result.args, ["cc", "-Wall", "-O3", "-o", "out"]);
  // The original map is not mutated.
  assert.equal(files.get("flags.rsp"), "-Wall -O2");
});

test("edit propagates through a two-level include chain", () => {
  const files = vfs({
    "main.rsp": "tool @mid.rsp end",
    "mid.rsp": "x @leaf.rsp y",
    "leaf.rsp": "deep",
  });
  const before = expand("main.rsp", files);
  assert.deepEqual(decode(before.text), ["tool", "x", "deep", "y", "end"]);
  const result = ok(applyEdits("main.rsp", files, new Set(), [{ index: 2, value: "deeper" }]));
  assert.equal(result.files.get("leaf.rsp"), "deeper");
  assert.equal(result.files.get("mid.rsp"), "x @leaf.rsp y");
  assert.deepEqual(result.args, ["tool", "x", "deeper", "y", "end"]);
});

test("values needing quotes round-trip through the source file", () => {
  const files = vfs({ "main.rsp": "run old done" });
  for (const value of ["", "it's", "a b", "line1\nline2", "@dir/file", '"quoted"']) {
    const result = ok(applyEdits("main.rsp", files, new Set(), [{ index: 1, value }]));
    assert.deepEqual(result.args, ["run", value, "done"], `value ${JSON.stringify(value)}`);
    // And the new source file still decodes to the same argv.
    assert.deepEqual(decode(expand("main.rsp", result.files).text), result.args);
  }
});

test("argument count is preserved by edits", () => {
  const files = vfs({ "main.rsp": "a b c d" });
  const result = ok(
    applyEdits("main.rsp", files, new Set(), [
      { index: 0, value: "" },
      { index: 1, value: "x y" },
      { index: 3, value: "'" },
    ]),
  );
  assert.equal(result.args.length, 4);
  assert.deepEqual(result.args, ["", "x y", "c", "'"]);
});

test("shared source: editing one reference updates all references", () => {
  const files = vfs({
    "main.rsp": "cc @a.rsp @b.rsp",
    "a.rsp": "@common.rsp -A",
    "b.rsp": "@common.rsp -B",
    "common.rsp": "--std=c20",
  });
  // args: cc --std=c20 -A --std=c20 -B ; edit only the first occurrence.
  const result = ok(applyEdits("main.rsp", files, new Set(), [{ index: 1, value: "--std=c23" }]));
  assert.equal(result.files.get("common.rsp"), "--std=c23");
  // Global consistency: the second occurrence follows the same source.
  assert.deepEqual(result.args, ["cc", "--std=c23", "-A", "--std=c23", "-B"]);
});

test("shared source: agreeing edits to several references are accepted", () => {
  const files = vfs({
    "main.rsp": "@common.rsp @common.rsp",
    "common.rsp": "v1",
  });
  const result = ok(
    applyEdits("main.rsp", files, new Set(), [
      { index: 0, value: "v2" },
      { index: 1, value: "v2" },
    ]),
  );
  assert.equal(result.files.get("common.rsp"), "v2");
  assert.deepEqual(result.args, ["v2", "v2"]);
});

test("conflicting edits to a shared source are all rejected", () => {
  const files = vfs({
    "main.rsp": "cc @a.rsp @b.rsp",
    "a.rsp": "@common.rsp -A",
    "b.rsp": "@common.rsp -B",
    "common.rsp": "--std=c20",
  });
  const result = applyEdits("main.rsp", files, new Set(), [
    { index: 1, value: "--std=c23" },
    { index: 3, value: "--std=c17" },
  ]);
  assert.ok(!result.ok, "conflicting batch must be rejected");
  assert.equal(result.conflicts.length, 1);
  const conflict = result.conflicts[0]!;
  assert.equal(conflict.file, "common.rsp");
  assert.equal(conflict.first, "--std=c23");
  assert.equal(conflict.second, "--std=c17");
  // Nothing was modified.
  assert.equal(files.get("common.rsp"), "--std=c20");
  assert.deepEqual(decode(expand("main.rsp", files).text), [
    "cc",
    "--std=c20",
    "-A",
    "--std=c20",
    "-B",
  ]);
});

test("edits inside conditional branches rewrite the taken branch source", () => {
  const files = vfs({
    "main.rsp": "base @if(debug) -g @else -O2 @endif end",
  });
  const conds = new Set(["debug"]);
  const result = ok(applyEdits("main.rsp", files, conds, [{ index: 1, value: "-g3" }]));
  assert.equal(result.files.get("main.rsp"), "base @if(debug) -g3 @else -O2 @endif end");
  assert.deepEqual(result.args, ["base", "-g3", "end"]);
  // The other branch is untouched and still selectable.
  const other = expand("main.rsp", result.files, new Set());
  assert.deepEqual(decode(other.text), ["base", "-O2", "end"]);
});

test("editing an argument sourced from a conditional include", () => {
  const files = vfs({
    "main.rsp": "tool @if(windows) @win.rsp @else @posix.rsp @endif done",
    "win.rsp": "/DWIN",
    "posix.rsp": "-DPOSIX",
  });
  const result = ok(
    applyEdits("main.rsp", files, new Set(), [{ index: 1, value: "-DUNIX" }]),
  );
  assert.equal(result.files.get("posix.rsp"), "-DUNIX");
  assert.equal(result.files.get("win.rsp"), "/DWIN");
  assert.deepEqual(result.args, ["tool", "-DUNIX", "done"]);
});

test("out-of-range index throws; NUL value rejected", () => {
  const files = vfs({ "main.rsp": "a b" });
  assert.throws(
    () => applyEdits("main.rsp", files, new Set(), [{ index: 5, value: "x" }]),
    /out of range/,
  );
  assert.throws(
    () => applyEdits("main.rsp", files, new Set(), [{ index: 0, value: "x\0y" }]),
    /NUL/,
  );
});
