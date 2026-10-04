import { test } from "node:test";
import { deepEqual, equal, match, ok } from "node:assert/strict";
import { applyEdits, planRename, RenameResult } from "../src/index.js";

function renameOk(source: string, marker: string, newName: string) {
  const offset = Buffer.byteLength(source.slice(0, source.indexOf(marker)), "utf8");
  const result = planRename(source, offset, newName);
  if (!result.ok) throw new Error(`expected rename to succeed, got: ${result.reason}`);
  return result.edits;
}

function renameErr(source: string, marker: string, newName: string): string {
  const offset = Buffer.byteLength(source.slice(0, source.indexOf(marker)), "utf8");
  const result: RenameResult = planRename(source, offset, newName);
  if (result.ok) throw new Error("expected rename to be rejected");
  return result.reason;
}

test("renames a declaration and only the references that resolve to it", () => {
  const src = "let total = 1;\ntotal = total + 1;\n";
  const edits = renameOk(src, "total", "sum");
  equal(edits.length, 3);
  equal(applyEdits(src, edits), "let sum = 1;\nsum = sum + 1;\n");
});

test("nested shadowing: renaming the outer binding leaves the inner one alone", () => {
  const src = "let x = 1;\n{\n  let x = 2;\n  x;\n}\nx;\n";
  const edits = renameOk(src, "x = 1", "outer");
  equal(applyEdits(src, edits), "let outer = 1;\n{\n  let x = 2;\n  x;\n}\nouter;\n");
});

test("nested shadowing: renaming the inner binding leaves the outer one alone", () => {
  const src = "let x = 1;\n{\n  let x = 2;\n  x;\n}\nx;\n";
  const edits = renameOk(src, "x = 2", "inner");
  equal(applyEdits(src, edits), "let x = 1;\n{\n  let inner = 2;\n  inner;\n}\nx;\n");
});

test("use before define: block-scoped declaration is visible in the whole block", () => {
  const src = "{\n  log(value);\n  let value = 1;\n  log(value);\n}\n";
  const edits = renameOk(src, "value = 1", "v");
  equal(applyEdits(src, edits), "{\n  log(v);\n  let v = 1;\n  log(v);\n}\n");
});

test("rename can be initiated from any reference, not just the declaration", () => {
  const src = "let a = 1;\na + a;\n";
  const edits = renameOk(src, "a + a", "b");
  equal(applyEdits(src, edits), "let b = 1;\nb + b;\n");
});

test("capture: renamed references would be captured by an inner binding — rejected", () => {
  const src = "let x = 1;\n{\n  let y = 2;\n  x + y;\n}\n";
  const reason = renameErr(src, "x = 1", "y");
  match(reason, /captured by another declaration/);
});

test("capture: existing references would be captured by the renamed binding — rejected", () => {
  const src = "let y = 10;\n{\n  let x = 1;\n  y + x;\n}\n";
  const reason = renameErr(src, "x = 1", "y");
  match(reason, /would capture the reference/);
});

test("capture: renaming to a global used inside the scope is rejected", () => {
  const src = "let x = 1;\nfunction f() {\n  log(x);\n}\n";
  const reason = renameErr(src, "x = 1", "log");
  match(reason, /would capture the reference/);
});

test("conflict: another declaration with the new name exists in the same scope", () => {
  const src = "{\n  let a = 1;\n  let b = 2;\n}\n";
  const reason = renameErr(src, "a = 1", "b");
  match(reason, /already declared in the same scope/);
});

test("rejection is atomic: a rejected rename yields no edits at all", () => {
  const src = "let x = 1;\n{\n  let y = 2;\n  x;\n}\nx;\n";
  const result = planRename(src, src.indexOf("x = 1"), "y");
  deepEqual(result.ok, false);
  if (!result.ok) match(result.reason, /captured/);
});

test("function parameters form their own scope and shadow outer bindings", () => {
  const src = "let n = 1;\nfunction f(n) {\n  return n + 1;\n}\nn;\n";
  const edits = renameOk(src, "n)", "m");
  equal(applyEdits(src, edits), "let n = 1;\nfunction f(m) {\n  return m + 1;\n}\nn;\n");
});

test("function declarations are renamed with their call sites", () => {
  const src = "function compute() {\n  return compute;\n}\ncompute();\n";
  const edits = renameOk(src, "compute()", "run");
  equal(applyEdits(src, edits), "function run() {\n  return run;\n}\nrun();\n");
});

test("for-loop declarations are scoped to the loop", () => {
  const src = "let i = 100;\nfor (let i = 0; i < 3; i++) {\n  i;\n}\ni;\n";
  const edits = renameOk(src, "i = 0", "k");
  equal(applyEdits(src, edits), "let i = 100;\nfor (let k = 0; k < 3; k++) {\n  k;\n}\ni;\n");
});

test("arrow function parameters shadow and rename independently", () => {
  const src = "let v = 1;\nconst f = (v) => v * 2;\nv;\n";
  const edits = renameOk(src, "v)", "w");
  equal(applyEdits(src, edits), "let v = 1;\nconst f = (w) => w * 2;\nv;\n");
});

test("member properties and object keys are not references", () => {
  const src = "let x = 1;\nconst obj = { x: x, other: 2 };\nobj.x;\nx;\n";
  const edits = renameOk(src, "x = 1", "y");
  equal(applyEdits(src, edits), "let y = 1;\nconst obj = { x: y, other: 2 };\nobj.x;\ny;\n");
});

test("unresolved global references are never renamed", () => {
  const src = "let x = 1;\nconsole.log(x);\n";
  const edits = renameOk(src, "x = 1", "y");
  equal(applyEdits(src, edits), "let y = 1;\nconsole.log(y);\n");
});

test("renaming an unresolved reference is rejected", () => {
  const src = "foo;\n";
  const reason = renameErr(src, "foo", "bar");
  match(reason, /unresolved reference/);
});

test("invalid new names are rejected", () => {
  const src = "let x = 1;\n";
  match(renameErr(src, "x = 1", "1abc"), /invalid identifier/);
  match(renameErr(src, "x = 1", "let"), /invalid identifier/);
  match(renameErr(src, "x = 1", "x"), /identical/);
});

test("no identifier at the given offset", () => {
  const src = "let x = 1;\n";
  const result = planRename(src, src.indexOf("="), "y");
  deepEqual(result.ok, false);
});

test("parse errors are reported, not thrown", () => {
  const result = planRename("let = ;", 0, "y");
  deepEqual(result.ok, false);
  if (!result.ok) match(result.reason, /parse error/);
});

test("edit plan uses UTF-8 byte offsets even with non-ASCII text before the target", () => {
  const src = "// 注释 comment\nlet x = 1;\nx;\n";
  const edits = renameOk(src, "x = 1", "y");
  const declByte = Buffer.byteLength("// 注释 comment\nlet ", "utf8");
  deepEqual(edits[0], { start: declByte, end: declByte + 1, newText: "y" });
  equal(applyEdits(src, edits), "// 注释 comment\nlet y = 1;\ny;\n");
});

test("edit plan is sorted and non-overlapping", () => {
  const src = "let abc = abc;\n{ abc; }\nabc;\n";
  const edits = renameOk(src, "abc =", "de");
  for (let i = 1; i < edits.length; i++) {
    ok(edits[i].start >= edits[i - 1].end, "edits must be sorted and non-overlapping");
  }
  equal(edits.length, 4);
});

test("deeply nested shadowing across three levels", () => {
  const src = "let a = 1;\n{\n  let b = a;\n  {\n    let a = b;\n    a;\n  }\n  a;\n}\n";
  const edits = renameOk(src, "a = 1", "top");
  equal(applyEdits(src, edits), "let top = 1;\n{\n  let b = top;\n  {\n    let a = b;\n    a;\n  }\n  top;\n}\n");
});

test("use before define in a nested block still resolves outward", () => {
  const src = "let count = 0;\nfunction bump() {\n  count = count + 1;\n}\nbump();\n";
  const edits = renameOk(src, "count = 0", "total");
  equal(
    applyEdits(src, edits),
    "let total = 0;\nfunction bump() {\n  total = total + 1;\n}\nbump();\n",
  );
});
